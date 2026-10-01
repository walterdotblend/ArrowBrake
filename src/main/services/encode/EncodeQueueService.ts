import {basename, dirname, extname, join} from 'node:path'
import {rename, stat, unlink} from 'node:fs/promises'
import type {ChildProcess} from 'node:child_process'
import EventEmitter from 'node:events'
import log from 'electron-log/main.js'
import {STATUS_KEY} from '@shared/schemas.js'
import type {GpuAcceleration, StatusKey, VideoEncode} from '@shared/types.js'
import {spawnFFmpeg, createStreamTextReader} from '@main/utils/process.js'
import {resolveEncoder, type EncoderResolveOptions} from './codecResolver.js'

const logger = log.scope('encode-queue')

export interface EncodeTask {
	itemId: string
	inputPath: string
	videoEncode: VideoEncode
	title?: string
}

interface ActiveTask {
	task: EncodeTask
	process: ChildProcess
	tempOutputPath: string
	finalOutputPath: string
	inputPath: string
	totalDuration: number | null
	lastPercent: number
	currentFps: number
	currentSpeed: string
	cancelRequested: boolean
	pauseRequested: boolean
}

export interface EncodeProgressUpdate {
	itemId: string
	percent: number
	detail: string
	fps: number
	speed: string
	totalFps: number
}

async function probeMediaDuration(ffmpegPath: string, inputPath: string): Promise<number | null> {
	return new Promise(resolve => {
		const proc = spawnFFmpeg(ffmpegPath, ['-i', inputPath])
		let stderr = ''
		proc.stderr.on('data', chunk => {
			stderr += chunk.toString()
		})
		proc.on('error', () => resolve(null))
		proc.on('close', () => {
			const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
			if (!match) return resolve(null)
			const hours = Number(match[1])
			const minutes = Number(match[2])
			const seconds = Number(match[3])
			const total = hours * 3600 + minutes * 60 + seconds
			resolve(Number.isFinite(total) && total > 0 ? total : null)
		})
	})
}

export class EncodeQueueService extends EventEmitter {
	private maxConcurrent = 1
	private gpuAcceleration: GpuAcceleration = 'auto'
	private gpuDeviceIndex = 0
	private pendingQueue: EncodeTask[] = []
	private activeTasks = new Map<string, ActiveTask>()
	private startingTasks = new Set<string>()

	constructor(private ffmpegPathProvider: () => string | null) {
		super()
	}

	setMaxConcurrent(value: number): void {
		this.maxConcurrent = Math.max(1, value)
		logger.info('Max concurrent encodes changed', {maxConcurrent: this.maxConcurrent})
		this.checkNext()
	}

	setGpuAcceleration(value: GpuAcceleration): void {
		this.gpuAcceleration = value
		logger.info('GPU acceleration changed', {gpuAcceleration: this.gpuAcceleration})
	}

	setGpuDeviceIndex(value: number): void {
		this.gpuDeviceIndex = value
		logger.info('GPU device index changed', {gpuDeviceIndex: this.gpuDeviceIndex})
	}

	isItemActive(itemId: string): boolean {
		return this.activeTasks.has(itemId)
	}

	isItemPending(itemId: string): boolean {
		return this.pendingQueue.some(t => t.itemId === itemId)
	}

	isItemInQueue(itemId: string): boolean {
		return this.isItemActive(itemId) || this.isItemPending(itemId) || this.startingTasks.has(itemId)
	}

	getTotalFps(): number {
		let total = 0
		for (const task of this.activeTasks.values()) {
			total += task.currentFps
		}
		return Math.round(total)
	}

	getActiveCount(): number {
		return this.activeTasks.size + this.startingTasks.size
	}

	getPendingCount(): number {
		return this.pendingQueue.length
	}

	enqueue(task: EncodeTask): void {
		if (this.isItemInQueue(task.itemId)) {
			logger.warn('Item already in encode queue', {itemId: task.itemId})
			return
		}

		logger.info('Enqueuing item for video encode', {itemId: task.itemId, inputPath: task.inputPath})

		if (this.activeTasks.size + this.startingTasks.size < this.maxConcurrent) {
			this.startingTasks.add(task.itemId)
			void this.startTask(task)
		} else {
			this.pendingQueue.push(task)
			this.emitStatus(task.itemId, STATUS_KEY.encodingPending)
			this.emit('progress', {
				itemId: task.itemId,
				percent: 0,
				detail: '',
				fps: 0,
				speed: '',
				totalFps: this.getTotalFps()
			} satisfies EncodeProgressUpdate)
		}
	}

	async cancel(itemId: string): Promise<boolean> {
		this.startingTasks.delete(itemId)

		// If pending, just remove from queue
		const pendingIdx = this.pendingQueue.findIndex(t => t.itemId === itemId)
		if (pendingIdx >= 0) {
			this.pendingQueue.splice(pendingIdx, 1)
			logger.info('Cancelled pending encode task', {itemId})
			return true
		}

		const active = this.activeTasks.get(itemId)
		if (active) {
			active.cancelRequested = true
			logger.info('Killing active FFmpeg encode process on cancel', {itemId})
			active.process.kill('SIGKILL')
			await unlink(active.tempOutputPath).catch(() => {})
			this.activeTasks.delete(itemId)
			this.emitTotalFps()
			this.checkNext()
			return true
		}

		return false
	}

	async pause(itemId: string): Promise<boolean> {
		this.startingTasks.delete(itemId)

		const pendingIdx = this.pendingQueue.findIndex(t => t.itemId === itemId)
		if (pendingIdx >= 0) {
			this.pendingQueue.splice(pendingIdx, 1)
			logger.info('Paused pending encode task', {itemId})
			return true
		}

		const active = this.activeTasks.get(itemId)
		if (active) {
			active.pauseRequested = true
			logger.info('Killing active FFmpeg encode process on pause', {itemId})
			active.process.kill('SIGKILL')
			await unlink(active.tempOutputPath).catch(() => {})
			this.activeTasks.delete(itemId)
			this.emitTotalFps()
			this.checkNext()
			return true
		}

		return false
	}

	private checkNext(): void {
		while (this.activeTasks.size + this.startingTasks.size < this.maxConcurrent && this.pendingQueue.length > 0) {
			const nextTask = this.pendingQueue.shift()
			if (nextTask) {
				this.startingTasks.add(nextTask.itemId)
				void this.startTask(nextTask)
			}
		}
		this.emitTotalFps()
	}

	private emitTotalFps(): void {
		this.emit('totalFps', {totalFps: this.getTotalFps(), activeCount: this.activeTasks.size})
	}

	private emitStatus(itemId: string, statusKey: StatusKey, params?: Record<string, string | number>): void {
		this.emit('status', {itemId, statusKey, params})
	}

	private async startTask(task: EncodeTask): Promise<void> {
		try {
			await this.runTask(task)
		} finally {
			this.startingTasks.delete(task.itemId)
		}
	}

	private async runTask(task: EncodeTask): Promise<void> {
		const ffmpegPath = this.ffmpegPathProvider()
		if (!ffmpegPath) {
			logger.error('Cannot encode: FFmpeg path not available', {itemId: task.itemId})
			this.emit('failed', {itemId: task.itemId, error: {kind: 'unknown', raw: 'FFmpeg no disponible'}})
			this.checkNext()
			return
		}

		const inputPath = task.inputPath
		try {
			const s = await stat(inputPath)
			if (!s.isFile()) {
				throw new Error('El archivo de origen no es un archivo regular')
			}
		} catch (err) {
			logger.error('Cannot encode: input file not found or invalid', {itemId: task.itemId, inputPath, error: String(err)})
			this.emit('failed', {itemId: task.itemId, error: {kind: 'unknown', raw: 'Archivo de video no encontrado en disco'}})
			this.checkNext()
			return
		}

		const resolveOpts: EncoderResolveOptions = {
			gpuAcceleration: this.gpuAcceleration,
			gpuDeviceIndex: this.gpuDeviceIndex
		}

		const resolved = await resolveEncoder(ffmpegPath, task.videoEncode, resolveOpts)
		this.emitStatus(task.itemId, STATUS_KEY.convertingVideo, {codec: resolved.displayName})

		const totalDuration = await probeMediaDuration(resolved.ffmpegPath, inputPath)
		logger.info('Starting independent encode job', {
			itemId: task.itemId,
			inputPath,
			encoder: resolved.encoder,
			displayName: resolved.displayName,
			isHardware: resolved.isHardware,
			totalDuration
		})

		const dir = dirname(inputPath)
		const ext = extname(inputPath)
		const stem = basename(inputPath, ext)
		const targetExt = `.${task.videoEncode.container.toLowerCase()}`
		const outputPath = join(dir, `${stem}${targetExt}`)
		const tempOutputPath = join(dir, `${stem}.encoding${targetExt}`)

		// Build args
		const args: string[] = ['-y']
		if (resolved.hwaccelArgs.length > 0) {
			args.push(...resolved.hwaccelArgs)
		}
		args.push('-i', inputPath)
		args.push('-map', '0:v:0', '-map', '0:a?')

		if (resolved.isCopy) {
			args.push('-c:v', 'copy')
		} else {
			args.push('-c:v', resolved.encoder)
			args.push(...resolved.rateControlArgs)
			args.push(...resolved.presetArgs)
		}

		args.push(...resolved.audioArgs)
		args.push('-progress', 'pipe:1')
		args.push(tempOutputPath)

		const proc = spawnFFmpeg(resolved.ffmpegPath, args)
		const activeTask: ActiveTask = {
			task,
			process: proc,
			tempOutputPath,
			finalOutputPath: outputPath,
			inputPath,
			totalDuration,
			lastPercent: 0,
			currentFps: 0,
			currentSpeed: '',
			cancelRequested: false,
			pauseRequested: false
		}

		this.activeTasks.set(task.itemId, activeTask)
		this.emitTotalFps()

		const reader = createStreamTextReader()

		proc.stdout.on('data', chunk => {
			const {lines} = reader.push(Buffer.from(chunk))
			if (!lines) return

			let currentOutTimeUs: number | null = null
			let currentSpeed = ''
			let currentFps = ''
			let isEnd = false

			for (const line of lines.split(/\r?\n/)) {
				const trimmed = line.trim()
				if (!trimmed) continue

				if (trimmed.startsWith('out_time_us=')) {
					const us = Number(trimmed.slice('out_time_us='.length))
					if (Number.isFinite(us)) currentOutTimeUs = us
				} else if (trimmed.startsWith('out_time_ms=')) {
					const ms = Number(trimmed.slice('out_time_ms='.length))
					if (Number.isFinite(ms) && currentOutTimeUs === null) currentOutTimeUs = ms
				} else if (trimmed.startsWith('speed=')) {
					currentSpeed = trimmed.slice('speed='.length).trim()
				} else if (trimmed.startsWith('fps=')) {
					currentFps = trimmed.slice('fps='.length).trim()
				} else if (trimmed === 'progress=end') {
					isEnd = true
				}
			}

			if (currentFps && currentFps !== '0.0' && currentFps !== '0.00') {
				activeTask.currentFps = Math.round(Number(currentFps))
				this.emitTotalFps()
			}
			if (currentSpeed && currentSpeed !== 'N/A') {
				activeTask.currentSpeed = currentSpeed
			}

			if (isEnd) {
				activeTask.lastPercent = 100
				activeTask.currentFps = 0
				this.emitTotalFps()
				return
			}

			if (currentOutTimeUs !== null && totalDuration && totalDuration > 0) {
				const elapsedSec = currentOutTimeUs / 1_000_000
				const calcPercent = Math.min(99, Math.max(0, Math.round((elapsedSec / totalDuration) * 100)))
				if (calcPercent > activeTask.lastPercent) {
					activeTask.lastPercent = calcPercent
				}

				const speedPart = activeTask.currentSpeed ? ` · ${activeTask.currentSpeed}` : ''
				const fpsPart = activeTask.currentFps > 0 ? `, ${activeTask.currentFps} fps` : ''
				const detail = `[${resolved.displayName}] · ${activeTask.lastPercent}%${speedPart}${fpsPart}`

				this.emit('progress', {
					itemId: task.itemId,
					percent: activeTask.lastPercent,
					detail,
					fps: activeTask.currentFps,
					speed: activeTask.currentSpeed,
					totalFps: this.getTotalFps()
				} satisfies EncodeProgressUpdate)
			}
		})

		proc.on('error', err => {
			logger.error('FFmpeg process error during encode', {itemId: task.itemId, error: err.message})
		})

		proc.on('close', async code => {
			this.activeTasks.delete(task.itemId)
			this.emitTotalFps()

			if (activeTask.cancelRequested || activeTask.pauseRequested) {
				await unlink(tempOutputPath).catch(() => {})
				this.checkNext()
				return
			}

			if (code !== 0) {
				logger.error('FFmpeg encoding failed with exit code', {itemId: task.itemId, code})
				await unlink(tempOutputPath).catch(() => {})
				// Soft-fail: keep original file so media is not lost
				this.emit('completed', {itemId: task.itemId, finalPath: inputPath})
				this.checkNext()
				return
			}

			// Success! Replace target output file
			try {
				if (inputPath !== outputPath) {
					await unlink(inputPath).catch(() => {})
				}
				await rename(tempOutputPath, outputPath)
				logger.info('Video encode completed successfully', {itemId: task.itemId, outputPath})
				this.emit('completed', {itemId: task.itemId, finalPath: outputPath})
			} catch (err) {
				logger.error('Failed to move encoded video into place', {itemId: task.itemId, error: String(err)})
				this.emit('completed', {itemId: task.itemId, finalPath: tempOutputPath})
			}

			this.checkNext()
		})
	}
}
