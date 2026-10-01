import log from 'electron-log/main.js'
import {spawnFFmpeg} from '@main/utils/process.js'
import type {GpuAcceleration, VideoEncode, VideoEncodePreset} from '@shared/types.js'

const logger = log.scope('encoder')

export interface EncoderResolveOptions {
	gpuAcceleration?: GpuAcceleration
	gpuDeviceIndex?: number
}

export interface ResolvedEncoderConfig {
	ffmpegPath: string
	encoder: string
	displayName: string
	isHardware: boolean
	isCopy: boolean
	hwaccelArgs: string[]
	rateControlArgs: string[]
	presetArgs: string[]
	audioArgs: string[]
}

// In-memory cache for encoder support during this session
const encoderSupportCache = new Map<string, boolean>()

export async function testEncoderSupport(ffmpegPath: string, encoder: string): Promise<boolean> {
	if (encoder === 'copy') return true
	const cacheKey = `${ffmpegPath}::${encoder}`
	if (encoderSupportCache.has(cacheKey)) {
		return encoderSupportCache.get(cacheKey)!
	}

	try {
		const supported = await new Promise<boolean>(resolve => {
			const child = spawnFFmpeg(ffmpegPath, [
				'-f', 'lavfi',
				'-i', 'color=c=black:s=256x256:d=0.04',
				'-c:v', encoder,
				'-f', 'null',
				'-'
			])

			let stderrOutput = ''
			child.stderr.on('data', chunk => {
				stderrOutput += chunk.toString()
			})

			child.on('error', () => resolve(false))
			child.on('close', code => {
				if (code === 0) {
					resolve(true)
				} else {
					logger.info(`Hardware probe for ${encoder} returned non-zero (${code}): ${stderrOutput.slice(0, 200).trim()}`)
					resolve(false)
				}
			})
		})

		encoderSupportCache.set(cacheKey, supported)
		return supported
	} catch {
		encoderSupportCache.set(cacheKey, false)
		return false
	}
}

export async function resolveEncoder(ffmpegPath: string, videoEncode: VideoEncode, options?: EncoderResolveOptions): Promise<ResolvedEncoderConfig> {
	const {codec, rateControl, crf, bitrateKbps, preset} = videoEncode

	if (codec === 'copy') {
		return {
			ffmpegPath,
			encoder: 'copy',
			displayName: 'Copiar (Stream copy)',
			isHardware: false,
			isCopy: true,
			hwaccelArgs: [],
			rateControlArgs: [],
			presetArgs: [],
			audioArgs: ['-c:a', 'copy']
		}
	}

	const forceCpu = options?.gpuAcceleration === 'cpu'
	let targetEncoder: string = codec
	let displayName: string = codec

	if (codec === 'auto') {
		if (forceCpu) {
			targetEncoder = 'h264'
			displayName = 'CPU (libx264)'
		} else {
			const tryNvidia = !options?.gpuAcceleration || options.gpuAcceleration === 'auto' || options.gpuAcceleration === 'nvidia'
			const tryIntel = !options?.gpuAcceleration || options.gpuAcceleration === 'auto' || options.gpuAcceleration === 'intel'
			const tryAmd = !options?.gpuAcceleration || options.gpuAcceleration === 'auto' || options.gpuAcceleration === 'amd'

			if (tryNvidia && (await testEncoderSupport(ffmpegPath, 'av1_nvenc'))) {
				targetEncoder = 'av1_nvenc'
				displayName = 'NVIDIA NVENC (AV1)'
			} else if (tryNvidia && (await testEncoderSupport(ffmpegPath, 'hevc_nvenc'))) {
				targetEncoder = 'hevc_nvenc'
				displayName = 'NVIDIA NVENC (HEVC)'
			} else if (tryNvidia && (await testEncoderSupport(ffmpegPath, 'h264_nvenc'))) {
				targetEncoder = 'h264_nvenc'
				displayName = 'NVIDIA NVENC (H.264)'
			} else if (tryIntel && (await testEncoderSupport(ffmpegPath, 'av1_qsv'))) {
				targetEncoder = 'av1_qsv'
				displayName = 'Intel QSV (AV1)'
			} else if (tryIntel && (await testEncoderSupport(ffmpegPath, 'hevc_qsv'))) {
				targetEncoder = 'hevc_qsv'
				displayName = 'Intel QSV (HEVC)'
			} else if (tryIntel && (await testEncoderSupport(ffmpegPath, 'h264_qsv'))) {
				targetEncoder = 'h264_qsv'
				displayName = 'Intel QSV (H.264)'
			} else if (tryAmd && (await testEncoderSupport(ffmpegPath, 'av1_amf'))) {
				targetEncoder = 'av1_amf'
				displayName = 'AMD AMF (AV1)'
			} else if (tryAmd && (await testEncoderSupport(ffmpegPath, 'hevc_amf'))) {
				targetEncoder = 'hevc_amf'
				displayName = 'AMD AMF (HEVC)'
			} else if (tryAmd && (await testEncoderSupport(ffmpegPath, 'h264_amf'))) {
				targetEncoder = 'h264_amf'
				displayName = 'AMD AMF (H.264)'
			} else {
				targetEncoder = 'h264'
				displayName = 'CPU (libx264)'
				logger.info('Auto encoder detection: no hardware encoder available or supported, falling back to CPU libx264')
			}
		}
	}

	// If a specific hardware encoder was selected, verify it works, otherwise fall back to software
	let actualEncoder: string = targetEncoder
	let isHardware = false
	const hwaccelArgs: string[] = []

	if (!forceCpu && targetEncoder.endsWith('_nvenc')) {
		if (await testEncoderSupport(ffmpegPath, targetEncoder)) {
			isHardware = true
			displayName = `NVIDIA NVENC (${targetEncoder.replace('_nvenc', '').toUpperCase()})`
			hwaccelArgs.push('-hwaccel', 'cuda')
		} else {
			logger.warn(`Encoder ${targetEncoder} is not supported by current driver; falling back to CPU`)
			if (targetEncoder.startsWith('hevc')) {
				actualEncoder = 'libx265'
				displayName = 'CPU Fallback (libx265)'
			} else if (targetEncoder.startsWith('av1')) {
				actualEncoder = 'libsvtav1'
				displayName = 'CPU Fallback (libsvtav1)'
			} else {
				actualEncoder = 'libx264'
				displayName = 'CPU Fallback (libx264)'
			}
		}
	} else if (!forceCpu && targetEncoder.endsWith('_qsv')) {
		if (await testEncoderSupport(ffmpegPath, targetEncoder)) {
			isHardware = true
			displayName = `Intel QSV (${targetEncoder.replace('_qsv', '').toUpperCase()})`
			hwaccelArgs.push('-hwaccel', 'qsv')
		} else {
			logger.warn(`Encoder ${targetEncoder} is not supported; falling back to CPU`)
			if (targetEncoder.startsWith('hevc')) actualEncoder = 'libx265'
			else if (targetEncoder.startsWith('av1')) actualEncoder = 'libsvtav1'
			else actualEncoder = 'libx264'
			displayName = `CPU Fallback (${actualEncoder})`
		}
	} else if (!forceCpu && targetEncoder.endsWith('_amf')) {
		if (await testEncoderSupport(ffmpegPath, targetEncoder)) {
			isHardware = true
			displayName = `AMD AMF (${targetEncoder.replace('_amf', '').toUpperCase()})`
			hwaccelArgs.push('-hwaccel', 'd3d11va')
		} else {
			logger.warn(`Encoder ${targetEncoder} is not supported; falling back to CPU`)
			if (targetEncoder.startsWith('hevc')) actualEncoder = 'libx265'
			else if (targetEncoder.startsWith('av1')) actualEncoder = 'libsvtav1'
			else actualEncoder = 'libx264'
			displayName = `CPU Fallback (${actualEncoder})`
		}
	} else {
		// CPU encoders
		switch (targetEncoder) {
			case 'hevc':
				actualEncoder = 'libx265'
				displayName = 'CPU (libx265)'
				break
			case 'av1':
				actualEncoder = 'libsvtav1'
				displayName = 'CPU (libsvtav1)'
				break
			case 'vp9':
				actualEncoder = 'libvpx-vp9'
				displayName = 'CPU (libvpx-vp9)'
				break
			case 'h264':
			default:
				actualEncoder = 'libx264'
				displayName = 'CPU (libx264)'
				break
		}
	}

	// Rate control arguments
	const rateControlArgs: string[] = []
	if (rateControl === 'bitrate') {
		const kbps = bitrateKbps ?? 2500
		rateControlArgs.push('-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`)
	} else {
		// CRF / Constant Quality
		const q = crf ?? 23
		if (isHardware && actualEncoder.endsWith('_nvenc')) {
			rateControlArgs.push('-rc', 'vbr', '-cq', `${q}`)
		} else if (isHardware && actualEncoder.endsWith('_qsv')) {
			rateControlArgs.push('-global_quality', `${q}`)
		} else if (isHardware && actualEncoder.endsWith('_amf')) {
			rateControlArgs.push('-rc', 'cqp', '-qp_i', `${q}`, '-qp_p', `${q}`)
		} else if (actualEncoder === 'libvpx-vp9') {
			rateControlArgs.push('-crf', `${q}`, '-b:v', '0')
		} else {
			// libx264, libx265, libsvtav1
			rateControlArgs.push('-crf', `${q}`)
		}
	}

	// Preset arguments
	const presetArgs = buildPresetArgs(actualEncoder, preset)
	if (isHardware && actualEncoder.endsWith('_nvenc') && options?.gpuDeviceIndex !== undefined) {
		presetArgs.push('-gpu', String(options.gpuDeviceIndex))
	}
	if (!isHardware) {
		presetArgs.push('-threads', '0')
	}

	// Audio arguments
	const audioArgs = ['-c:a', 'copy']

	return {
		ffmpegPath,
		encoder: actualEncoder,
		displayName,
		isHardware,
		isCopy: false,
		hwaccelArgs,
		rateControlArgs,
		presetArgs,
		audioArgs
	}
}

function buildPresetArgs(encoder: string, preset: VideoEncodePreset): string[] {
	if (encoder === 'libsvtav1') {
		// SVT-AV1 presets 0..13 (higher = faster)
		const svtPresets: Record<VideoEncodePreset, string> = {
			ultrafast: '12',
			fast: '10',
			medium: '8',
			slow: '5'
		}
		return ['-preset', svtPresets[preset] ?? '8']
	}

	if (encoder === 'libvpx-vp9') {
		const vp9Speed: Record<VideoEncodePreset, string> = {
			ultrafast: '4',
			fast: '2',
			medium: '1',
			slow: '0'
		}
		return ['-cpu-used', vp9Speed[preset] ?? '1']
	}

	if (encoder.endsWith('_nvenc')) {
		const nvencPresets: Record<VideoEncodePreset, string> = {
			ultrafast: 'p1',
			fast: 'p3',
			medium: 'p4',
			slow: 'p6'
		}
		return ['-preset', nvencPresets[preset] ?? 'p4']
	}

	return ['-preset', preset]
}
