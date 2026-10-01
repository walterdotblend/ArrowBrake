import {basename, dirname, extname, join} from 'node:path'
import {rename, stat, unlink} from 'node:fs/promises'
import log from 'electron-log/main.js'
import {STATUS_KEY} from '@shared/schemas.js'
import {spawnFFmpeg, createStreamTextReader} from '@main/utils/process.js'
import {resolveEncoder} from '../encode/codecResolver.js'
import type {Phase, PhaseContext, PhaseOutcome} from './types.js'

const logger = log.scope('encode-phase')

// Helper to probe total video duration in seconds via ffmpeg -i
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

export const EncodePhase: Phase = {
	kind: 'encode',
	async run(ctx: PhaseContext): Promise<PhaseOutcome> {
		const {active, ytDlp} = ctx
		const {job, input} = active
		const preparedJob = input.job

		if (preparedJob.kind !== 'single-format' && preparedJob.kind !== 'ranged-format') {
			return {kind: 'continue'}
		}
		if (!preparedJob.videoEncode?.enabled) {
			return {kind: 'continue'}
		}

		const ffmpegPath = ytDlp.ffmpegPath
		if (!ffmpegPath) {
			logger.warn('Video encode phase skipped — ffmpeg not available', {jobId: job.id})
			return {kind: 'continue'}
		}

		const inputPath = active.mediaPath
		if (!inputPath) {
			logger.warn('Video encode phase skipped — no mediaPath registered', {jobId: job.id})
			return {kind: 'continue'}
		}

		try {
			const s = await stat(inputPath)
			if (!s.isFile()) {
				logger.warn('Video encode phase skipped — mediaPath is not a regular file', {jobId: job.id, inputPath})
				return {kind: 'continue'}
			}
		} catch {
			logger.warn('Video encode phase skipped — mediaPath not found on disk', {jobId: job.id, inputPath})
			return {kind: 'continue'}
		}

		const videoEncode = preparedJob.videoEncode
		const resolved = await resolveEncoder(ffmpegPath, videoEncode)

		ctx.emitStatus('download', STATUS_KEY.convertingVideo, {codec: resolved.displayName})
		ctx.emitProgress?.(0, `Iniciando codificación [${resolved.displayName}]…`)

		const totalDuration = await probeMediaDuration(ffmpegPath, inputPath)
		logger.info('Starting video encode', {jobId: job.id, inputPath, encoder: resolved.encoder, totalDuration})

		const dir = dirname(inputPath)
		const ext = extname(inputPath)
		const stem = basename(inputPath, ext)
		const targetExt = `.${videoEncode.container.toLowerCase()}`
		const outputPath = join(dir, `${stem}${targetExt}`)
		const tempOutputPath = join(dir, `${stem}.encoding${targetExt}`)

		// Build ffmpeg args
		const args: string[] = ['-y', '-i', inputPath]

		// Map streams
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

		let lastPercent = 0
		const reader = createStreamTextReader()

		const parseProgressOutput = (text: string): void => {
			const {lines} = reader.push(Buffer.from(text, 'utf8'))
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
					// Some ffmpeg builds emit out_time_ms in microseconds
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

			if (isEnd) {
				lastPercent = 100
				ctx.emitProgress?.(100, `Codificación completada [${resolved.displayName}]`)
				return
			}

			if (currentOutTimeUs !== null && totalDuration && totalDuration > 0) {
				const elapsedSec = currentOutTimeUs / 1_000_000
				const calcPercent = Math.min(99, Math.max(0, Math.round((elapsedSec / totalDuration) * 100)))
				if (calcPercent > lastPercent) lastPercent = calcPercent

				const speedPart = currentSpeed && currentSpeed !== 'N/A' ? ` · ${currentSpeed}` : ''
				const fpsPart = currentFps && currentFps !== '0.0' && currentFps !== '0.00' ? `, ${Math.round(Number(currentFps))} fps` : ''
				const detail = `Codificando [${resolved.displayName}] · ${lastPercent}%${speedPart}${fpsPart}`

				ctx.emitProgress?.(lastPercent, detail)
			}
		}

		const exitCode = await new Promise<number | null>(resolve => {
			const proc = spawnFFmpeg(ffmpegPath, args)
			active.ffmpegProcess = proc

			if (active.cancelRequested) {
				proc.kill('SIGKILL')
				resolve(-1)
				return
			}

			ctx.register(() => {
				proc.kill('SIGKILL')
			})

			proc.stdout.on('data', chunk => {
				parseProgressOutput(chunk.toString())
			})

			proc.on('error', err => {
				logger.error('FFmpeg process error during encode', {jobId: job.id, error: err.message})
				resolve(-1)
			})

			proc.on('close', code => {
				resolve(code)
			})
		}).finally(() => {
			active.ffmpegProcess = undefined
		})

		if (active.pauseRequested) {
			await unlink(tempOutputPath).catch(() => {})
			return {kind: 'paused'}
		}

		if (active.cancelRequested || exitCode !== 0) {
			await unlink(tempOutputPath).catch(() => {})
			if (active.cancelRequested) return {kind: 'cancelled'}
			logger.error('FFmpeg encoding failed with exit code', {jobId: job.id, exitCode})
			// Soft fail or continue without replacing mediaPath so user's downloaded media is preserved
			return {kind: 'continue'}
		}

		// Success! Replace or rename to target output path
		try {
			// If input file was distinct from output file, delete the unencoded original
			if (inputPath !== outputPath) {
				await unlink(inputPath).catch(err => {
					logger.warn('Could not unlink original media after encode', {jobId: job.id, inputPath, message: String(err)})
				})
			} else {
				// If target was same filename as original, remove original before renaming temp
				await unlink(inputPath).catch(() => {})
			}

			await rename(tempOutputPath, outputPath)
			active.mediaPath = outputPath
			logger.info('Video encode completed successfully', {jobId: job.id, outputPath, encoder: resolved.displayName})
			ctx.emitProgress?.(100, `Codificado listo [${resolved.displayName}]`)
		} catch (err) {
			logger.error('Failed to move encoded file into place', {jobId: job.id, error: String(err)})
			await unlink(tempOutputPath).catch(() => {})
		}

		return {kind: 'continue'}
	}
}
