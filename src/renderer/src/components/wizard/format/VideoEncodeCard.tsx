import {useMemo, type ReactNode} from 'react'
import {Film, HelpCircle, HardDrive, Zap, Info} from 'lucide-react'
import {useTranslation} from 'react-i18next'
import type {VideoEncode, VideoEncodeCodec, VideoEncodeContainer, VideoEncodePreset, VideoEncodeRateControl} from '@shared/types.js'
import {VIDEO_ENCODE_CODECS, VIDEO_ENCODE_CONTAINERS} from '@shared/types.js'
import {ToggleGroup, ToggleGroupItem} from '../../ui/toggle-group.js'
import {cn} from '@renderer/lib/utils.js'
import {Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue} from '../../ui/select.js'

interface VideoEncodeCardProps {
	videoEncode: VideoEncode
	durationSeconds?: number
	originalFilesizeBytes?: number
	videoHeight?: number
	onChange: (videoEncode: Partial<VideoEncode>) => void
	className?: string
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const CRF_PRESETS = [18, 20, 23, 26, 28] as const
const BITRATE_PRESETS = [1500, 2500, 4000, 8000, 12000] as const

export const CONTAINER_CODEC_COMPATIBILITY: Record<VideoEncodeContainer, VideoEncodeCodec[]> = {
	mkv: ['auto', 'h264', 'hevc', 'av1', 'vp9', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf', 'copy'],
	mp4: ['auto', 'h264', 'hevc', 'av1', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf', 'copy'],
	webm: ['auto', 'av1', 'vp9', 'av1_nvenc', 'av1_qsv', 'av1_amf', 'copy'],
	mov: ['auto', 'h264', 'hevc', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf', 'copy'],
	avi: ['auto', 'h264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'copy']
}

function isCompatible(container: VideoEncodeContainer, codec: VideoEncodeCodec): boolean {
	return CONTAINER_CODEC_COMPATIBILITY[container]?.includes(codec) ?? false
}

export function VideoEncodeCard({videoEncode, durationSeconds, originalFilesizeBytes, videoHeight, onChange, className}: VideoEncodeCardProps): ReactNode {
	const {t} = useTranslation()
	const isCopy = videoEncode.codec === 'copy'
	const isAv1 = videoEncode.codec === 'av1' || videoEncode.codec === 'av1_nvenc' || videoEncode.codec === 'av1_qsv' || videoEncode.codec === 'av1_amf'
	const isHevc = videoEncode.codec === 'hevc' || videoEncode.codec === 'hevc_nvenc' || videoEncode.codec === 'hevc_qsv' || videoEncode.codec === 'hevc_amf'

	const CODEC_LABELS: Record<VideoEncodeCodec, string> = {
		auto: `⚡ ${t('wizard.url.videoEncode.groupAuto')} (GPU)`,
		h264_nvenc: 'H.264 (NVIDIA NVENC)',
		hevc_nvenc: 'H.265 / HEVC (NVIDIA NVENC)',
		av1_nvenc: 'AV1 (NVIDIA NVENC)',
		h264_qsv: 'H.264 (Intel QSV)',
		hevc_qsv: 'H.265 / HEVC (Intel QSV)',
		av1_qsv: 'AV1 (Intel QSV)',
		h264_amf: 'H.264 (AMD AMF)',
		hevc_amf: 'H.265 / HEVC (AMD AMF)',
		av1_amf: 'AV1 (AMD AMF)',
		h264: 'H.264 (x264 CPU)',
		hevc: 'H.265 / HEVC (x265 CPU)',
		av1: 'AV1 (SVT-AV1 CPU)',
		vp9: 'VP9 (libvpx CPU)',
		copy: t('wizard.url.videoEncode.groupDirect')
	}

	const ENCODE_PRESETS: {value: VideoEncodePreset; label: string}[] = [
		{value: 'ultrafast', label: t('wizard.url.videoEncode.presetUltrafast')},
		{value: 'fast', label: t('wizard.url.videoEncode.presetFast')},
		{value: 'medium', label: t('wizard.url.videoEncode.presetMedium')},
		{value: 'slow', label: t('wizard.url.videoEncode.presetSlow')}
	]

	// Estimate bitrate & file size
	const estimatedMetrics = useMemo(() => {
		if (isCopy) {
			if (originalFilesizeBytes && originalFilesizeBytes > 0) {
				return {
					sizeText: formatBytes(originalFilesizeBytes),
					rateText: durationSeconds && durationSeconds > 0 ? `~${Math.round(((originalFilesizeBytes * 8) / durationSeconds) / 1000)} kbps` : null,
					diffBadge: null
				}
			}
			return null
		}

		let videoKbps: number
		if (videoEncode.rateControl === 'bitrate') {
			videoKbps = videoEncode.bitrateKbps ?? 2500
		} else {
			// CRF estimation
			const crf = videoEncode.crf ?? 23
			let baseBitrate = 2200 // Default base kbps for 1080p
			const c = videoEncode.codec
			if (c === 'h264' || c === 'h264_nvenc' || c === 'h264_qsv' || c === 'h264_amf') {
				baseBitrate = 3500
			} else if (c === 'hevc' || c === 'hevc_nvenc' || c === 'hevc_qsv' || c === 'hevc_amf') {
				baseBitrate = 2200
			} else if (c === 'vp9') {
				baseBitrate = 2400
			} else if (c === 'av1' || c === 'av1_nvenc' || c === 'av1_qsv' || c === 'av1_amf') {
				baseBitrate = 1600
			}

			const h = videoHeight && videoHeight > 0 ? videoHeight : 1080
			const resFactor = Math.pow(Math.max(h, 240) / 1080, 1.4)
			const crfFactor = Math.pow(2, (23 - crf) / 6)
			const speedFactor = videoEncode.preset === 'slow' ? 0.92 : videoEncode.preset === 'ultrafast' ? 1.15 : videoEncode.preset === 'fast' ? 1.05 : 1.0

			videoKbps = Math.round(baseBitrate * resFactor * crfFactor * speedFactor)
		}

		const totalKbps = videoKbps + 160 // include ~160k audio
		const rateText = totalKbps >= 1000 ? `~${(totalKbps / 1000).toFixed(2)} Mbps` : `~${totalKbps} kbps`

		if (durationSeconds && durationSeconds > 0) {
			const estimatedBytes = (totalKbps * 1000 / 8) * durationSeconds
			const sizeText = `~${formatBytes(estimatedBytes)}`
			let diffBadge: {text: string; isReduction: boolean} | null = null

			if (originalFilesizeBytes && originalFilesizeBytes > 0) {
				const diff = Math.round(((estimatedBytes - originalFilesizeBytes) / originalFilesizeBytes) * 100)
				if (diff < -3) {
					diffBadge = {
						text: `↓ ${Math.abs(diff)}% ${t('wizard.url.videoEncode.sizeReduction')}`,
						isReduction: true
					}
				} else if (diff > 3) {
					diffBadge = {
						text: `↑ ${diff}% ${t('wizard.url.videoEncode.sizeIncrease')}`,
						isReduction: false
					}
				}
			}

			return {sizeText, rateText, diffBadge}
		}

		// When duration is unknown (e.g. Profile Editor or Playlists): estimate relative percentage
		let relativePercent: number
		if (videoEncode.rateControl === 'bitrate') {
			const b = videoEncode.bitrateKbps ?? 2500
			relativePercent = Math.min(Math.max(Math.round((b / 3500) * 100), 15), 180)
		} else {
			const crf = videoEncode.crf ?? 23
			let baseEff = 0.75
			const c = videoEncode.codec
			if (c === 'av1' || c === 'av1_nvenc' || c === 'av1_qsv' || c === 'av1_amf') {
				baseEff = 0.38
			} else if (c === 'hevc' || c === 'hevc_nvenc' || c === 'hevc_qsv' || c === 'hevc_amf' || c === 'auto') {
				baseEff = 0.50
			} else if (c === 'vp9') {
				baseEff = 0.55
			}
			const crfFactor = Math.pow(2, (23 - crf) / 6)
			relativePercent = Math.min(Math.max(Math.round(baseEff * crfFactor * 100), 10), 200)
		}

		const reduction = 100 - relativePercent
		return {
			sizeText: t('wizard.url.videoEncode.relativeSize', {percent: relativePercent}),
			rateText: rateText,
			diffBadge:
				reduction > 0
					? {
							text: t('wizard.url.videoEncode.relativeReduction', {percent: reduction}),
							isReduction: true
						}
					: null
		}
	}, [isCopy, videoEncode.rateControl, videoEncode.bitrateKbps, videoEncode.crf, videoEncode.codec, videoEncode.preset, videoHeight, durationSeconds, originalFilesizeBytes, t])

	const handleContainerChange = (container: VideoEncodeContainer): void => {
		if (!isCompatible(container, videoEncode.codec)) {
			// Auto fallback to 'auto' or compatible codec
			onChange({container, codec: 'auto'})
		} else {
			onChange({container})
		}
	}

	const handleCodecChange = (codec: VideoEncodeCodec): void => {
		if (!isCompatible(videoEncode.container, codec)) {
			// Auto fallback to MKV which supports all codecs
			onChange({codec, container: 'mkv'})
		} else {
			onChange({codec})
		}
	}

	return (
		<div className={cn('rounded-xl border border-[var(--border-strong)] bg-card/60 p-3.5 shadow-sm flex flex-col gap-3', className)} data-testid="video-encode-card">
			<div className="flex items-center justify-between border-b border-[var(--border-strong)] pb-2">
				<div className="flex items-center gap-2">
					<Film className="size-4 text-primary" aria-hidden />
					<span className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-subtle)]">
						{t('wizard.url.videoEncode.cardTitle')}
					</span>
				</div>
				<span className="text-[11px] text-muted-foreground font-mono">
					{videoEncode.container.toUpperCase()} · {CODEC_LABELS[videoEncode.codec] ?? videoEncode.codec}
				</span>
			</div>

			{/* Quick Preset Buttons */}
			<div className="flex flex-col gap-1.5 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
				<div className="flex items-center justify-between">
					<span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-primary">
						<Zap className="size-3.5" aria-hidden />
						{t('wizard.url.videoEncode.quickPresets.label')}
					</span>
				</div>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
					<button
						type="button"
						onClick={() => onChange({container: 'mp4', codec: 'h264_nvenc', rateControl: 'crf', crf: 22, preset: 'medium'})}
						title={t('wizard.url.videoEncode.quickPresets.h264CompatTooltip')}
						className={cn(
							'flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-all hover:border-primary/50 hover:bg-card',
							(videoEncode.codec === 'h264_nvenc' || videoEncode.codec === 'h264') && videoEncode.crf === 22 && videoEncode.container === 'mp4'
								? 'border-primary bg-card shadow-[0_0_10px_var(--brand-glow)]'
								: 'border-border bg-card/60'
						)}
					>
						<span className="text-[11px] font-semibold leading-tight text-foreground">{t('wizard.url.videoEncode.quickPresets.h264Compat')}</span>
						<span className="font-mono text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.quickPresets.h264CompatTooltip')}</span>
					</button>

					<button
						type="button"
						onClick={() => onChange({container: 'mkv', codec: 'av1_nvenc', rateControl: 'crf', crf: 26, preset: 'medium'})}
						title={t('wizard.url.videoEncode.quickPresets.av1EfficientTooltip')}
						className={cn(
							'relative flex flex-col items-start gap-0.5 overflow-hidden rounded-lg border p-2 text-left transition-all hover:border-primary/50 hover:bg-card',
							(videoEncode.codec === 'av1_nvenc' || videoEncode.codec === 'av1') && videoEncode.crf === 26
								? 'border-primary bg-card shadow-[0_0_10px_var(--brand-glow)]'
								: 'border-border bg-card/60'
						)}
					>
						<div className="flex w-full items-center justify-between">
							<span className="text-[11px] font-semibold leading-tight text-foreground">{t('wizard.url.videoEncode.quickPresets.av1Efficient')}</span>
							<span className="rounded bg-primary/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">⭐ {t('wizard.url.videoEncode.quickPresets.av1EfficientBadge')}</span>
						</div>
						<span className="font-mono text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.quickPresets.av1EfficientTooltip')}</span>
					</button>

					<button
						type="button"
						onClick={() => onChange({container: 'mkv', codec: 'av1_nvenc', rateControl: 'crf', crf: 30, preset: 'medium'})}
						title={t('wizard.url.videoEncode.quickPresets.av1LightTooltip')}
						className={cn(
							'flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-all hover:border-primary/50 hover:bg-card',
							(videoEncode.codec === 'av1_nvenc' || videoEncode.codec === 'av1') && videoEncode.crf === 30
								? 'border-primary bg-card shadow-[0_0_10px_var(--brand-glow)]'
								: 'border-border bg-card/60'
						)}
					>
						<span className="text-[11px] font-semibold leading-tight text-foreground">{t('wizard.url.videoEncode.quickPresets.av1Light')}</span>
						<span className="font-mono text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.quickPresets.av1LightTooltip')}</span>
					</button>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
				{/* Contenedor / Formato */}
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center gap-1.5">
						<label className="text-[11px] font-semibold text-[var(--text-subtle)] uppercase tracking-wide">
							{t('wizard.url.videoEncode.container')}
						</label>
						<span title={t('wizard.url.videoEncode.containerTooltip')} className="cursor-help text-muted-foreground hover:text-foreground">
							<HelpCircle size={12} aria-hidden />
						</span>
					</div>
					<ToggleGroup
						value={[videoEncode.container]}
						onValueChange={vals => {
							const val = vals[0] as VideoEncodeContainer | undefined
							if (val && VIDEO_ENCODE_CONTAINERS.includes(val)) {
								handleContainerChange(val)
							}
						}}
						spacing={1}
						className="flex-wrap justify-start gap-1"
					>
						{VIDEO_ENCODE_CONTAINERS.map(c => {
							const compatible = isCompatible(c, videoEncode.codec)
							return (
								<ToggleGroupItem
									key={c}
									value={c}
									shape="chip"
									disabled={!compatible}
									title={compatible ? `${c.toUpperCase()}` : t('wizard.url.videoEncode.incompatibleTooltip', {container: c.toUpperCase()})}
									className={cn(
										'min-h-6 uppercase font-mono px-2.5 text-[11px] font-semibold transition-opacity',
										!compatible && 'opacity-35 cursor-not-allowed line-through'
									)}
								>
									{c}
								</ToggleGroupItem>
							)
						})}
					</ToggleGroup>
				</div>

				{/* Códec de vídeo */}
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center gap-1.5">
						<label className="text-[11px] font-semibold text-[var(--text-subtle)] uppercase tracking-wide">
							{t('wizard.url.videoEncode.codec')}
						</label>
						<span title={t('wizard.url.videoEncode.codecTooltip')} className="cursor-help text-muted-foreground hover:text-foreground">
							<HelpCircle size={12} aria-hidden />
						</span>
					</div>
					<Select
						value={videoEncode.codec}
						onValueChange={val => {
							if (val && VIDEO_ENCODE_CODECS.includes(val as VideoEncodeCodec)) {
								handleCodecChange(val as VideoEncodeCodec)
							}
						}}
					>
						<SelectTrigger className="w-full h-8 text-[12px]">
							<SelectValue>{(val: VideoEncodeCodec) => CODEC_LABELS[val] ?? val}</SelectValue>
						</SelectTrigger>
						<SelectContent align="start" side="bottom" alignItemWithTrigger={false} className="max-h-72">
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupAuto')}</SelectLabel>
								<SelectItem value="auto">⚡ {t('wizard.url.videoEncode.groupAuto')}</SelectItem>
							</SelectGroup>
							<SelectSeparator />
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupNvidia')}</SelectLabel>
								<SelectItem value="hevc_nvenc" disabled={!isCompatible(videoEncode.container, 'hevc_nvenc')}>
									H.265 / HEVC (NVENC) {!isCompatible(videoEncode.container, 'hevc_nvenc') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="h264_nvenc" disabled={!isCompatible(videoEncode.container, 'h264_nvenc')}>
									H.264 (NVENC) {!isCompatible(videoEncode.container, 'h264_nvenc') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="av1_nvenc" disabled={!isCompatible(videoEncode.container, 'av1_nvenc')}>
									AV1 (NVENC) {!isCompatible(videoEncode.container, 'av1_nvenc') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
							</SelectGroup>
							<SelectSeparator />
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupIntel')}</SelectLabel>
								<SelectItem value="hevc_qsv" disabled={!isCompatible(videoEncode.container, 'hevc_qsv')}>
									H.265 / HEVC (QSV) {!isCompatible(videoEncode.container, 'hevc_qsv') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="h264_qsv" disabled={!isCompatible(videoEncode.container, 'h264_qsv')}>
									H.264 (QSV) {!isCompatible(videoEncode.container, 'h264_qsv') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="av1_qsv" disabled={!isCompatible(videoEncode.container, 'av1_qsv')}>
									AV1 (QSV) {!isCompatible(videoEncode.container, 'av1_qsv') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
							</SelectGroup>
							<SelectSeparator />
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupAmd')}</SelectLabel>
								<SelectItem value="hevc_amf" disabled={!isCompatible(videoEncode.container, 'hevc_amf')}>
									H.265 / HEVC (AMF) {!isCompatible(videoEncode.container, 'hevc_amf') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="h264_amf" disabled={!isCompatible(videoEncode.container, 'h264_amf')}>
									H.264 (AMF) {!isCompatible(videoEncode.container, 'h264_amf') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="av1_amf" disabled={!isCompatible(videoEncode.container, 'av1_amf')}>
									AV1 (AMF) {!isCompatible(videoEncode.container, 'av1_amf') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
							</SelectGroup>
							<SelectSeparator />
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupCpu')}</SelectLabel>
								<SelectItem value="h264" disabled={!isCompatible(videoEncode.container, 'h264')}>
									H.264 (libx264 CPU) {!isCompatible(videoEncode.container, 'h264') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="hevc" disabled={!isCompatible(videoEncode.container, 'hevc')}>
									H.265 / HEVC (libx265 CPU) {!isCompatible(videoEncode.container, 'hevc') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="av1" disabled={!isCompatible(videoEncode.container, 'av1')}>
									AV1 (SVT-AV1 CPU) {!isCompatible(videoEncode.container, 'av1') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
								<SelectItem value="vp9" disabled={!isCompatible(videoEncode.container, 'vp9')}>
									VP9 (libvpx CPU) {!isCompatible(videoEncode.container, 'vp9') && `[${t('wizard.url.videoEncode.incompatibleTooltip', {container: videoEncode.container.toUpperCase()})}]`}
								</SelectItem>
							</SelectGroup>
							<SelectSeparator />
							<SelectGroup>
								<SelectLabel>{t('wizard.url.videoEncode.groupDirect')}</SelectLabel>
								<SelectItem value="copy">{t('wizard.url.videoEncode.groupDirect')}</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
					<span className="text-[10px] text-muted-foreground">
						{t('wizard.url.videoEncode.autoGpuTip')}
					</span>
				</div>
			</div>

			{/* Opciones de tasa y compresión (solo si no es 'copy') */}
			{!isCopy && (
				<div className="border-t border-[var(--border-strong)]/60 pt-2.5 flex flex-col gap-3">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 flex-wrap">
						{/* Modo de calidad */}
						<div className="flex items-center gap-2 flex-wrap">
							<div className="flex items-center gap-1">
								<span className="text-[11px] font-semibold text-[var(--text-subtle)] uppercase tracking-wide">
									{t('wizard.url.videoEncode.rateControl')}
								</span>
								<span title={t('wizard.url.videoEncode.rateControlTooltip')} className="cursor-help text-muted-foreground hover:text-foreground">
									<HelpCircle size={11} aria-hidden />
								</span>
							</div>
							<ToggleGroup
								value={[videoEncode.rateControl]}
								onValueChange={vals => {
									const val = vals[0] as VideoEncodeRateControl | undefined
									if (val === 'crf' || val === 'bitrate') {
										onChange({rateControl: val})
									}
								}}
								spacing={1}
								className="gap-1 flex-wrap"
							>
								<ToggleGroupItem value="crf" shape="chip" className="min-h-6 px-2 text-[11px] font-medium" title={t('wizard.url.videoEncode.rateControlTooltip')}>
									{t('wizard.url.videoEncode.crfMode')}
								</ToggleGroupItem>
								<ToggleGroupItem value="bitrate" shape="chip" className="min-h-6 px-2 text-[11px] font-medium" title={t('wizard.url.videoEncode.rateControlTooltip')}>
									{t('wizard.url.videoEncode.bitrateMode')}
								</ToggleGroupItem>
							</ToggleGroup>
						</div>

						{/* Preset selector */}
						<div className="flex items-center gap-1.5 flex-wrap">
							<div className="flex items-center gap-1">
								<span className="text-[11px] text-[var(--text-subtle)] font-medium">
									{t('wizard.url.videoEncode.speed')}
								</span>
								<span title={t('wizard.url.videoEncode.speedTooltip')} className="cursor-help text-muted-foreground hover:text-foreground">
									<HelpCircle size={11} aria-hidden />
								</span>
							</div>
							<ToggleGroup
								value={[videoEncode.preset]}
								onValueChange={vals => {
									const val = vals[0] as VideoEncodePreset | undefined
									if (val) onChange({preset: val})
								}}
								spacing={1}
								className="gap-1 flex-wrap"
							>
								{ENCODE_PRESETS.map(p => (
									<ToggleGroupItem key={p.value} value={p.value} shape="chip" className="min-h-5 px-1.5 text-[10px] font-medium" title={t('wizard.url.videoEncode.speedTooltip')}>
										{p.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</div>
					</div>

					{/* Rate details: CRF or Bitrate */}
					{videoEncode.rateControl === 'crf' ? (
						<div className="flex flex-wrap items-center justify-between gap-2 bg-secondary/30 rounded-lg p-2 border border-[var(--border-strong)]/50">
							<div className="flex items-center gap-1.5 flex-wrap">
								<span className="text-[11px] font-medium">{t('wizard.url.videoEncode.crfValue')}</span>
								<input
									type="number"
									min={0}
									max={51}
									step={1}
									value={videoEncode.crf ?? 23}
									onChange={e => {
										const val = Number.parseInt(e.target.value, 10)
										if (!Number.isNaN(val) && val >= 0 && val <= 51) {
											onChange({crf: val})
										}
									}}
									className="h-6 w-14 rounded border border-[var(--border-strong)] bg-background px-1.5 text-center text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
									aria-label="Valor CRF"
								/>
								<span className="text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.crfHint')}</span>
							</div>

							<div className="flex items-center gap-1 flex-wrap">
								<span className="text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.presets')}</span>
								<div className="flex items-center gap-1 flex-wrap">
									{CRF_PRESETS.map(val => (
										<button
											type="button"
											key={val}
											onClick={() => onChange({crf: val})}
											title={`CRF ${val}`}
											className={cn('h-5 px-1.5 rounded text-[10px] font-mono transition-colors border', videoEncode.crf === val ? 'bg-primary text-primary-foreground border-primary font-bold' : 'border-[var(--border-strong)] bg-background hover:bg-accent text-foreground')}
										>
											{val}
										</button>
									))}
								</div>
							</div>
						</div>
					) : (
						<div className="flex flex-wrap items-center justify-between gap-2 bg-secondary/30 rounded-lg p-2 border border-[var(--border-strong)]/50">
							<div className="flex items-center gap-1.5 flex-wrap">
								<span className="text-[11px] font-medium">{t('wizard.url.videoEncode.bitrateValue')}</span>
								<input
									type="number"
									min={100}
									max={100000}
									step={250}
									value={videoEncode.bitrateKbps ?? 2500}
									onChange={e => {
										const val = Number.parseInt(e.target.value, 10)
										if (!Number.isNaN(val) && val >= 100 && val <= 100000) {
											onChange({bitrateKbps: val})
										}
									}}
									className="h-6 w-20 rounded border border-[var(--border-strong)] bg-background px-1.5 text-right text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
									aria-label="Bitrate en kbps"
								/>
								<span className="text-[10px] font-mono text-muted-foreground">kbps</span>
							</div>

							<div className="flex items-center gap-1 flex-wrap">
								<span className="text-[10px] text-muted-foreground">{t('wizard.url.videoEncode.presets')}</span>
								<div className="flex items-center gap-1 flex-wrap">
									{BITRATE_PRESETS.map(val => (
										<button
											type="button"
											key={val}
											onClick={() => onChange({bitrateKbps: val})}
											title={`${val} kbps`}
											className={cn('h-5 px-1.5 rounded text-[10px] font-mono transition-colors border', videoEncode.bitrateKbps === val ? 'bg-primary text-primary-foreground border-primary font-bold' : 'border-[var(--border-strong)] bg-background hover:bg-accent text-foreground')}
										>
											{val >= 1000 ? `${val / 1000}M` : `${val}k`}
										</button>
									))}
								</div>
							</div>
						</div>
					)}

					{/* Live estimation badge */}
					{estimatedMetrics && (
						<div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
							<div className="flex items-center gap-1.5 min-w-0">
								<HardDrive className="size-3.5 text-primary shrink-0" aria-hidden />
								<span className="text-[11px] font-medium text-muted-foreground">{t('wizard.url.videoEncode.estimatedSize')}</span>
								<span className="font-mono font-bold text-foreground">{estimatedMetrics.sizeText}</span>
								{estimatedMetrics.diffBadge && (
									<span
										className={cn(
											'text-[10px] font-semibold px-1.5 py-0.5 rounded-full border',
											estimatedMetrics.diffBadge.isReduction ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-amber-500 bg-amber-500/10 border-amber-500/20'
										)}
									>
										{estimatedMetrics.diffBadge.text}
									</span>
								)}
							</div>
							<div className="flex items-center gap-1 shrink-0 font-mono text-[10px] text-muted-foreground">
								<span>{estimatedMetrics.rateText}</span>
							</div>
						</div>
					)}

					{/* Codec compatibility notices */}
					{isAv1 && (
						<div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-500">
							<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>{t('wizard.url.videoEncode.noticeAv1')}</span>
						</div>
					)}
					{isHevc && (
						<div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] leading-snug text-sky-500">
							<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>{t('wizard.url.videoEncode.noticeHevc')}</span>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
