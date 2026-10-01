import {useMemo, useState, type ReactNode} from 'react'
import {useTranslation} from 'react-i18next'
import {useShallow} from 'zustand/react/shallow'
import {useAppStore} from '../../store/useAppStore.js'
import {useFormatSelectionView, type FormatSelectionFilters} from '../../store/formatSelectionView.js'
import {VideoSummaryCard} from '../shared/VideoSummaryCard.js'
import {Spinner} from '../ui/spinner.js'
import downloadingImg from '../../assets/Downloading.png'
import {PresetStrip} from './format/PresetStrip.js'
import {VideoColumn} from './format/VideoColumn.js'
import {BotWallNotice} from './format/BotWallNotice.js'
import {AudioColumn} from './format/AudioColumn.js'
import {VideoEncodeCard} from './format/VideoEncodeCard.js'
import {Checkbox} from '../ui/checkbox.js'
import {FormatFooter} from './format/FormatFooter.js'

export function StepFormatSelect(): ReactNode {
	const {t} = useTranslation()
	const {formatsLoading, wizardTitle, wizardThumbnail, wizardDuration, wizardWebpageUrl, wizardFormats, selectedVideoFormatId, audioSelection, activePreset, wizardEncodeEnabled, wizardVideoEncode, setSelectedVideoFormatId, setAudioSelection, setPreset, setWizardEncodeEnabled, setWizardVideoEncode, advance, back, skipToConfirm} =
		useAppStore(
			useShallow(state => ({
				formatsLoading: state.formatsLoading,
				wizardTitle: state.wizardTitle,
				wizardThumbnail: state.wizardThumbnail,
				wizardDuration: state.wizardDuration,
				wizardWebpageUrl: state.wizardWebpageUrl,
				wizardFormats: state.wizardFormats,
				selectedVideoFormatId: state.selectedVideoFormatId,
				audioSelection: state.audioSelection,
				activePreset: state.activePreset,
				wizardEncodeEnabled: state.wizardEncodeEnabled,
				wizardVideoEncode: state.wizardVideoEncode,
				setSelectedVideoFormatId: state.setSelectedVideoFormatId,
				setAudioSelection: state.setAudioSelection,
				setPreset: state.setPreset,
				setWizardEncodeEnabled: state.setWizardEncodeEnabled,
				setWizardVideoEncode: state.setWizardVideoEncode,
				advance: state.advance,
				back: state.back,
				skipToConfirm: state.skipToConfirm
			}))
		)
	const [videoExtFilter, setVideoExtFilter] = useState<string | null>(null)
	const [dynamicRangeFilter, setDynamicRangeFilter] = useState<string | null>(null)
	const [audioExtFilter, setAudioExtFilter] = useState<string | null>(null)
	const filters = useMemo<FormatSelectionFilters>(() => ({audioExt: audioExtFilter, dynamicRange: dynamicRangeFilter, videoExt: videoExtFilter}), [audioExtFilter, dynamicRangeFilter, videoExtFilter])
	const view = useFormatSelectionView(filters)
	const selectedVideoFormat = useMemo(() => wizardFormats.find(f => f.formatId === selectedVideoFormatId), [wizardFormats, selectedVideoFormatId])

	if (formatsLoading) {
		return (
			<div className="wizard-step flex flex-col items-center gap-4 py-8">
				<div className="rounded-2xl bg-[var(--brand-dim)] p-4 shadow-[0_0_28px_var(--brand-glow)]">
					<img src={downloadingImg} alt="" aria-hidden className="size-28 object-contain" />
				</div>
				<div className="relative rounded-xl border border-border bg-secondary px-4 py-2.5 text-sm text-muted-foreground leading-relaxed shadow-sm text-center max-w-[260px]">
					<span aria-hidden className="absolute -top-[7px] left-1/2 -translate-x-1/2 w-0 h-0" style={{borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '7px solid var(--border)'}} />
					<span aria-hidden className="absolute -top-[5px] left-1/2 -translate-x-1/2 w-0 h-0" style={{borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '7px solid var(--secondary)'}} />
					{t('wizard.formats.sniffing')}
				</div>
				<div className="flex items-center gap-2 text-xs text-[var(--text-subtle)]">
					<Spinner aria-label={t('wizard.formats.loadingAria')} />
					<span>{t('wizard.formats.loadingHint')}</span>
				</div>
			</div>
		)
	}

	return (
		<div className="wizard-step flex flex-col gap-3" data-testid="step-formats">
			<VideoSummaryCard thumbnail={wizardThumbnail} title={wizardTitle} duration={wizardDuration} resolution={view.currentResolutionLabel} webpageUrl={wizardWebpageUrl} />

			<PresetStrip activePreset={activePreset} onSelect={setPreset} />

			<BotWallNotice />

			{/* Checkbox Codificar */}
			<div className="flex items-center justify-between rounded-xl border border-[var(--border-strong)] bg-card/40 px-3.5 py-2.5 shadow-sm">
				<div className="flex items-center gap-2.5">
					<Checkbox id="encode-toggle" checked={wizardEncodeEnabled} onCheckedChange={checked => setWizardEncodeEnabled(checked === true)} />
					<label htmlFor="encode-toggle" className="cursor-pointer select-none">
						<span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
							{t('wizard.formats.encodeCheckbox.label')}
							<span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-mono text-primary font-medium">{t('wizard.formats.encodeCheckbox.tag')}</span>
						</span>
						<span className="block text-[11px] text-[var(--text-subtle)]">{t('wizard.formats.encodeCheckbox.description')}</span>
					</label>
				</div>
				{!wizardEncodeEnabled ? (
					<span className="text-[11px] font-medium text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">{t('wizard.formats.encodeCheckbox.directBadge')}</span>
				) : (
					<span className="text-[11px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">{t('wizard.formats.encodeCheckbox.reencodeBadge')}</span>
				)}
			</div>

			{/* Panel de codificación de vídeo si Codificar está activo y hay vídeo seleccionado */}
			{wizardEncodeEnabled && selectedVideoFormatId !== '' && view.mode !== 'subtitle-only' && (
				<VideoEncodeCard
					videoEncode={wizardVideoEncode}
					durationSeconds={wizardDuration}
					originalFilesizeBytes={view.selectedFilesize}
					videoHeight={selectedVideoFormat?.resolution ? Number.parseInt(selectedVideoFormat.resolution, 10) : undefined}
					onChange={setWizardVideoEncode}
				/>
			)}

			<div className="grid grid-cols-2 gap-[20px]">
				<VideoColumn view={view.video} selectedVideoFormatId={selectedVideoFormatId} videoExtFilter={videoExtFilter} dynamicRangeFilter={dynamicRangeFilter} onVideoExtFilterChange={setVideoExtFilter} onDynamicRangeFilterChange={setDynamicRangeFilter} onSelect={setSelectedVideoFormatId} />
				<AudioColumn view={view.audio} mode={view.mode} audioSelection={audioSelection} audioExtFilter={audioExtFilter} encodeEnabled={wizardEncodeEnabled} onAudioExtFilterChange={setAudioExtFilter} onSelect={setAudioSelection} />
			</div>

			<FormatFooter view={view} onBack={back} onContinue={advance} onSkipToConfirm={skipToConfirm} />
		</div>
	)
}
