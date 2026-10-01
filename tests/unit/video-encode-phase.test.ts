import {describe, it, expect} from 'vitest'
import {phasesFor} from '@main/services/phases/index.js'
import {resolveEncoder} from '@main/services/encode/codecResolver.js'
import {queueStatusFilterCount} from '@renderer/components/queue/queueManagerActions.js'
import type {PreparedJob, SponsorBlockOptions, EmbedOptions} from '@shared/preparedJob.js'
import type {QueueItem} from '@shared/types.js'
import {STATUS_KEY} from '@shared/schemas.js'

const EMBED_OFF: EmbedOptions = {chapters: false, metadata: false, thumbnail: false, description: false, thumbnailSidecar: false}
const SB_OFF: SponsorBlockOptions = {mode: 'off'}

describe('phasesFor — VideoEncode decoupling', () => {
	it('does not include encode in download phases (decoupled to EncodeQueueService)', () => {
		const job: PreparedJob = {
			kind: 'single-format',
			extractor: 'youtube',
			extractorKey: 'Youtube',
			formatId: '137+140',
			preset: 'custom',
			sponsorBlock: SB_OFF,
			embed: EMBED_OFF,
			videoEncode: {
				enabled: true,
				container: 'mkv',
				codec: 'hevc',
				rateControl: 'crf',
				crf: 22,
				bitrateKbps: 2500,
				preset: 'fast'
			}
		}

		const phases = phasesFor({url: 'https://example.com/watch?v=123', outputDir: '/out', job}).map(p => p.kind)
		// Decoupled: DownloadService completes without running encode phase, freeing the download slot
		expect(phases).not.toContain('encode')
	})

	it('does not include encode phase when videoEncode is disabled or omitted', () => {
		const job: PreparedJob = {
			kind: 'single-format',
			extractor: 'youtube',
			extractorKey: 'Youtube',
			formatId: '137+140',
			preset: 'custom',
			sponsorBlock: SB_OFF,
			embed: EMBED_OFF,
			videoEncode: {
				enabled: false,
				container: 'mp4',
				codec: 'h264',
				rateControl: 'crf',
				crf: 23,
				bitrateKbps: 2500,
				preset: 'medium'
			}
		}

		const phases = phasesFor({url: 'https://example.com/watch?v=123', outputDir: '/out', job}).map(p => p.kind)
		expect(phases).not.toContain('encode')
	})
})

describe('resolveEncoder', () => {
	it('resolves copy mode without rate control args', async () => {
		const config = await resolveEncoder('ffmpeg', {
			enabled: true,
			container: 'mp4',
			codec: 'copy',
			rateControl: 'crf',
			crf: 23,
			bitrateKbps: 2500,
			preset: 'medium'
		})

		expect(config.isCopy).toBe(true)
		expect(config.encoder).toBe('copy')
		expect(config.rateControlArgs).toEqual([])
	})

	it('resolves CPU x264 with CRF and preset', async () => {
		const config = await resolveEncoder('ffmpeg', {
			enabled: true,
			container: 'mp4',
			codec: 'h264',
			rateControl: 'crf',
			crf: 20,
			bitrateKbps: 2500,
			preset: 'slow'
		})

		expect(config.encoder).toBe('libx264')
		expect(config.rateControlArgs).toContain('-crf')
		expect(config.rateControlArgs).toContain('20')
		expect(config.presetArgs).toEqual(['-preset', 'slow', '-threads', '0'])
	})

	it('resolves CPU x265 with Bitrate', async () => {
		const config = await resolveEncoder('ffmpeg', {
			enabled: true,
			container: 'mkv',
			codec: 'hevc',
			rateControl: 'bitrate',
			crf: 23,
			bitrateKbps: 4500,
			preset: 'fast'
		})

		expect(config.encoder).toBe('libx265')
		expect(config.rateControlArgs).toContain('-b:v')
		expect(config.rateControlArgs).toContain('4500k')
	})
})

describe('queueStatusFilterCount — encoding filter', () => {
	it('counts only running items that are in convertingVideo status', () => {
		const dummyJob = {
			kind: 'single-format' as const,
			extractor: 'youtube',
			extractorKey: 'Youtube',
			formatId: 'bv+ba',
			preset: 'custom' as const,
			sponsorBlock: SB_OFF,
			embed: EMBED_OFF
		}

		const baseItem = {
			error: null,
			artifacts: [],
			writeM3u: false,
			retryCount: 0,
			finishedAt: null,
			job: dummyJob
		}

		const queue: QueueItem[] = [
			{
				...baseItem,
				id: 'item-1',
				url: 'https://example.com/1',
				title: 'Download 1',
				thumbnail: '',
				status: 'running',
				lane: 'normal',
				addedAt: new Date().toISOString(),
				outputDir: '/out',
				formatLabel: '1080p',
				progressPercent: 50,
				progressDetail: 'Downloading…',
				lastStatus: {key: STATUS_KEY.downloadingMedia}
			},
			{
				...baseItem,
				id: 'item-2',
				url: 'https://example.com/2',
				title: 'Download 2 (Encoding)',
				thumbnail: '',
				status: 'running',
				lane: 'normal',
				addedAt: new Date().toISOString(),
				outputDir: '/out',
				formatLabel: '1080p [MKV · HEVC]',
				progressPercent: 35,
				progressDetail: 'Codificando [HEVC] · 35%',
				lastStatus: {key: STATUS_KEY.convertingVideo}
			},
			{
				...baseItem,
				id: 'item-3',
				url: 'https://example.com/3',
				title: 'Download 3 (Done)',
				thumbnail: '',
				status: 'done',
				lane: 'normal',
				addedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				outputDir: '/out',
				formatLabel: '1080p',
				progressPercent: 100,
				progressDetail: null,
				lastStatus: {key: STATUS_KEY.complete}
			}
		]

		expect(queueStatusFilterCount('all', queue)).toBe(3)
		expect(queueStatusFilterCount('running', queue)).toBe(2)
		expect(queueStatusFilterCount('encoding', queue)).toBe(1)
		expect(queueStatusFilterCount('done', queue)).toBe(1)
	})
})
