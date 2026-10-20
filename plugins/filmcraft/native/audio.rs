//! Read-only, bounded audio excerpts for the plugin's multimodal tools.
//! Imported-item reads use source time and original media; timeline track reads use the renderer's actual timeline track input (clip processing before its mixer).
use base64::{Engine as _, engine::general_purpose::STANDARD};
use filmcraft_audio_dsp::channels::{Layout, Mixdown};
use serde_json::{Value, json};

use crate::{EngineError, Result, Session, commands::bad};

pub fn read(s: &Session, p: &Value) -> Result<Value> {
    const CMD: &str = "audio.read";
    let number = |key: &str| p[key].as_f64().filter(|v| v.is_finite()).ok_or_else(|| bad(CMD, format!("{key} must be a finite number")));
    let start = number("startSeconds")?;
    let duration = number("durationSeconds")?;
    if start < 0.0 || duration <= 0.0 || duration > 30.0 {
        return Err(bad(CMD, "startSeconds must be nonnegative and durationSeconds must be greater than zero and at most 30"));
    }
    let rate = match p.get("sampleRate") {
        None => 16_000,
        Some(v) => match v.as_u64() {
            Some(16_000) => 16_000,
            Some(24_000) => 24_000,
            _ => return Err(bad(CMD, "sampleRate must be 16000 or 24000")),
        },
    };
    if p.get("item").is_some() && p.get("track").is_some() {
        return Err(bad(CMD, "item and track are mutually exclusive"));
    }
    if p.get("audioStream").is_some() && p.get("item").is_none() {
        return Err(bad(CMD, "audioStream requires an imported media item"));
    }
    if let Some(item) = p.get("item") {
        let item = item.as_u64().filter(|i| *i > 0 && *i <= 9_007_199_254_740_991)
            .ok_or_else(|| bad(CMD, "item must be a positive, safe integer imported media ID"))?;
        return read_item(s, p, filmcraft_project::ItemId(item), start, duration, rate);
    }
    let id = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
    let seq = s.project.sequence(id).ok_or(EngineError::NoSequence)?;
    let end = start + duration;
    let sequence_end = seq.duration().seconds();
    if !end.is_finite() || start >= sequence_end {
        return Err(bad(CMD, "startSeconds must be before the end of the active sequence"));
    }
    let track_id = crate::commands::track_p(s, p, "track", CMD)?;
    let track = track_id.map(|id| {
        seq.audio_tracks.iter().enumerate().find(|(_, t)| t.id == id).ok_or_else(|| bad(CMD, "track must identify an audio track"))
    }).transpose()?;
    // Align the returned range to its PCM sample grid, never past the sequence end.
    let first = (start * rate as f64).floor() as i64;
    let last = ((end.min(sequence_end) * rate as f64).floor() as i64).min(first.saturating_add(rate as i64 * 30));
    let frames = (last - first) as usize;
    if frames == 0 {
        return Err(bad(CMD, "requested range is shorter than one output sample"));
    }
    let source_rate = seq.settings.sample_rate;
    if source_rate == 0 || source_rate > 384_000 {
        return Err(bad(CMD, "sequence sample rate is outside the supported range"));
    }
    let provider = s.media.provider(s.project.clone(), s.services.clone()).recording();
    let mut resampler = filmcraft_audio_dsp::resample::StreamResampler::new(source_rate, rate);
    let mut pcm = Vec::with_capacity(frames * 2);
    // Keep native render allocations bounded even for 384 kHz / surround projects.
    for offset in (0..frames).step_by(4096) {
        let count = 4096.min(frames - offset);
        let channels = resampler.process(first + offset as i64, count, |at, n| {
            let buffer = match track {
                Some((_, t)) => filmcraft_render::audio::track_input(&s.project, t, at, n, source_rate, &provider),
                None => filmcraft_render::audio::mix_sequence(&s.project, seq, at, n, &provider),
            };
            filmcraft_render::audio::to_layout(buffer, Layout::Mono, Mixdown::FrontRear).channels
        });
        for index in 0..count {
            let sample = channels.first().and_then(|c| c.get(index)).copied().unwrap_or(0.0);
            let sample = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
            pcm.extend_from_slice(&((sample * 32767.0).round() as i16).to_le_bytes());
        }
    }
    let actual_start = first as f64 / rate as f64;
    let actual_duration = frames as f64 / rate as f64;
    Ok(json!({
        "encoding": "base64", "mimeType": "audio/pcm", "format": "pcm_s16le", "data": STANDARD.encode(pcm),
        "sampleRate": rate, "channels": 1, "frameCount": frames,
        "sequence": {"id": id.0, "name": s.project.item(id).map(|i| i.name.as_str()).unwrap_or("")},
        "requestedRange": {"startSeconds": start, "durationSeconds": duration, "endSeconds": end},
        "actualRange": {"startSeconds": actual_start, "durationSeconds": actual_duration, "endSeconds": actual_start + actual_duration},
        "track": track.map(|(i, t)| json!({"id": t.id.0, "label": format!("A{}", i + 1), "name": t.name})),
        "timeBasis": "timeline",
        "signalPath": if track.is_some() { "track_input_pre_mixer" } else { "sequence_mix" },
        "offlineMedia": provider.offline_used(),
    }))
}

/// Read a bin item without opening the source monitor or creating any timeline state.
fn read_item(s: &Session, p: &Value, id: filmcraft_project::ItemId, start: f64, duration: f64, rate: u32) -> Result<Value> {
    use filmcraft_project::{ItemKind, MediaRef};
    use filmcraft_render::SourceProvider;
    const CMD: &str = "audio.read";
    let item = s.project.item(id).ok_or_else(|| bad(CMD, "item must identify imported media"))?;
    let ItemKind::Media(media) = &item.kind else {
        return Err(bad(CMD, "item must identify imported media, not a sequence or subclip"));
    };
    let MediaRef::File { path } = &media.media else {
        return Err(bad(CMD, "item must identify an imported media file"));
    };
    if media.info.audio_streams.is_empty() {
        return Err(bad(CMD, "imported media has no audio streams"));
    }
    let stream = match p.get("audioStream") {
        None => 0,
        Some(value) => value.as_u64().and_then(|i| usize::try_from(i).ok())
            .filter(|i| *i < media.info.audio_streams.len())
            .ok_or_else(|| bad(CMD, "audioStream must be a zero-based integer index into availableAudioStreams"))?,
    };
    let end = start + duration;
    let media_end = media.info.duration.seconds();
    if !end.is_finite() || !media_end.is_finite() || start >= media_end {
        return Err(bad(CMD, "startSeconds must be before the end of the imported media"));
    }
    let first = (start * rate as f64).floor() as i64;
    let last = ((end.min(media_end) * rate as f64).floor() as i64).min(first.saturating_add(rate as i64 * 30));
    let frames = (last - first) as usize;
    if frames == 0 {
        return Err(bad(CMD, "requested range is shorter than one output sample"));
    }
    // Original audio is intentional even when the editor has proxy playback enabled.
    let provider = s.media.full_res_provider(s.project.clone(), s.services.clone()).recording();
    let source = provider.source(id).ok_or_else(|| bad(CMD, "cannot resolve imported media"))?;
    let mut pcm = Vec::with_capacity(frames * 2);
    for offset in (0..frames).step_by(4096) {
        let count = 4096.min(frames - offset);
        let buffer = source.audio_stream(stream, first + offset as i64, count, rate)
            .map_err(|e| bad(CMD, format!("cannot decode original audio stream {stream}: {e}")))?;
        let mono = filmcraft_render::audio::to_layout(buffer, Layout::Mono, Mixdown::FrontRear);
        for index in 0..count {
            let sample = mono.channels.first().and_then(|c| c.get(index)).copied().unwrap_or(0.0);
            let sample = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
            pcm.extend_from_slice(&((sample * 32767.0).round() as i16).to_le_bytes());
        }
    }
    let streams: Vec<Value> = media.info.audio_streams.iter().enumerate().map(|(i, a)| json!({
        "index": i, "sampleRate": a.sample_rate, "channels": a.channels, "codec": a.codec, "bitsPerSample": a.bits_per_sample,
    })).collect();
    let actual_start = first as f64 / rate as f64;
    let actual_duration = frames as f64 / rate as f64;
    let offline = provider.offline_used();
    Ok(json!({
        "encoding": "base64", "mimeType": "audio/pcm", "format": "pcm_s16le", "data": STANDARD.encode(pcm),
        "sampleRate": rate, "channels": 1, "frameCount": frames,
        "source": {"item": id.0, "name": item.name, "kind": media.info.kind, "mediaPath": path, "durationSeconds": media_end},
        "audioStream": streams[stream], "availableAudioStreams": streams,
        "requestedRange": {"startSeconds": start, "durationSeconds": duration, "endSeconds": end},
        "actualRange": {"startSeconds": actual_start, "durationSeconds": actual_duration, "endSeconds": actual_start + actual_duration},
        "timeBasis": "source", "signalPath": "source_original",
        "mediaStatus": {"original": if offline.is_empty() { "online" } else { "offline" }, "proxyUsed": false},
        "offlineMedia": offline,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use filmcraft_project::{ClipId, ItemId};
    use filmcraft_time::Tick;
    use std::sync::Arc;

    fn fixture() -> (Session, ItemId, ClipId) {
        let result = fixture_seconds(2);
        assert_eq!(result.0.active_sequence().unwrap().duration().seconds(), 2.0);
        result
    }
    fn fixture_seconds(seconds: u32) -> (Session, ItemId, ClipId) {
        let mut s = Session::default();
        s.execute("file.newSequence", json!({"name": "audio fixture", "audio": 2, "video": 1, "fps":24})).unwrap();
        // Known WAV: a different constant in each half, making source offsets/speed observable.
        let samples: Vec<f32> = (0..seconds * 48_000).flat_map(|i| { let x = if i < 48_000 { 0.1 } else { 0.4 }; [x, x] }).collect();
        let bytes = crate::previews::write_wav_f32(&samples, 48_000);
        let item = crate::commands::import_bytes(&mut s, "/audio-read-fixture.wav", bytes.into(), None).unwrap();
        let placed = s.execute("timeline.place", json!({"item":item.0,"audioTrack":"A1","seconds":0})).unwrap();
        (s, item, ClipId(placed["clips"][0].as_u64().unwrap()))
    }
    fn samples(value: &Value) -> Vec<i16> {
        STANDARD.decode(value["data"].as_str().unwrap()).unwrap().chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
    }
    fn rms(value: &Value) -> f64 {
        let samples = samples(value);
        (samples.iter().map(|v| (*v as f64 / 32767.0).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }
    fn imported_wav(s: &mut Session, seconds: u32) -> ItemId {
        let samples: Vec<f32> = (0..seconds * 48_000).flat_map(|i| [if i < 48_000 { 0.1 } else { 0.4 }; 2]).collect();
        let bytes = crate::previews::write_wav_f32(&samples, 48_000);
        crate::commands::import_bytes(s, "/source-audio-read.wav", bytes.into(), None).unwrap()
    }
    #[test]
    fn audio_read_imported_wav_without_sequence_placement_or_monitor() {
        let mut s = Session::default();
        let item = imported_wav(&mut s, 31);
        assert!(s.state.active_sequence.is_none());
        assert!(s.state.source_item.is_none());
        s.state.project_selection = vec![item];
        s.state.source_playhead = Tick::from_seconds_f64(0.7);
        let state = serde_json::to_value(&s.state).unwrap();
        let project = s.project.clone();
        let history = s.execute("history.list", json!({})).unwrap();
        let revision = s.revision;
        let journal = s.journal.clone();
        for (start, expected) in [(0.25, 0.1), (1.25, 0.4)] {
            let value = s.execute("audio.read", json!({"item":item.0,"startSeconds":start,"durationSeconds":0.25})).unwrap();
            assert_eq!(value["source"]["item"], item.0);
            assert_eq!(value["source"]["durationSeconds"], 31.0);
            assert_eq!(value["timeBasis"], "source");
            assert_eq!(value["signalPath"], "source_original");
            assert_eq!(value["audioStream"]["index"], 0);
            assert_eq!(value["availableAudioStreams"][0]["sampleRate"], 48000);
            assert_eq!(value["mediaStatus"], json!({"original":"online","proxyUsed":false}));
            assert_eq!(value["actualRange"]["startSeconds"], start);
            assert!(value.get("sequence").is_none());
            assert!(value.get("track").is_none());
            assert!((rms(&value) - expected * 2.0 * std::f64::consts::FRAC_1_SQRT_2).abs() < 0.0001);
        }
        let clamped = read(&s, &json!({"item":item.0,"startSeconds":30.75,"durationSeconds":1})).unwrap();
        assert_eq!(clamped["actualRange"]["endSeconds"], 31.0);
        assert_eq!(clamped["frameCount"], 4000);
        for rate in [16000, 24000] {
            let value = read(&s, &json!({"item":item.0,"startSeconds":0.123456789,"durationSeconds":30,"sampleRate":rate})).unwrap();
            assert_eq!(value["frameCount"], rate * 30);
            assert_eq!(value["actualRange"]["startSeconds"], (0.123456789 * rate as f64).floor() / rate as f64);
        }
        assert!(Arc::ptr_eq(&project, &s.project));
        assert_eq!(serde_json::to_value(&s.state).unwrap(), state);
        assert_eq!(s.revision, revision);
        assert_eq!(s.journal, journal);
        assert_eq!(s.execute("history.list", json!({})).unwrap(), history);
    }
    #[test]
    fn audio_read_imported_movie_selects_stream_and_bypasses_proxy() {
        use filmcraft_frame::{AudioBuffer, VideoFrame};
        use filmcraft_media::{FrameRequest, MediaInfo, MediaSource};
        use filmcraft_project::{ItemKind, Label, MediaClip, MediaRef};
        use std::sync::Mutex;
        struct Movie { info: MediaInfo, calls: Mutex<Vec<(usize, i64, usize, u32)>> }
        impl MediaSource for Movie {
            fn info(&self) -> &MediaInfo { &self.info }
            fn video_frame(&self, _: FrameRequest) -> filmcraft_media::Result<Arc<VideoFrame>> { Err(filmcraft_media::MediaError::NoStream("video")) }
            fn audio(&self, start: i64, frames: usize, rate: u32) -> filmcraft_media::Result<AudioBuffer> { self.audio_stream(0, start, frames, rate) }
            fn audio_stream(&self, stream: usize, start: i64, frames: usize, rate: u32) -> filmcraft_media::Result<AudioBuffer> {
                self.calls.lock().unwrap().push((stream, start, frames, rate));
                Ok(AudioBuffer { sample_rate: rate, channels: vec![vec![if stream == 1 { 0.3 } else { 0.1 }; frames]; 2] })
            }
        }
        let mut s = Session::default();
        let generator = filmcraft_media::generators::GeneratorSource::new(filmcraft_media::Generator::BarsAndTone, 32, 18, filmcraft_time::FrameRate::FPS_24, Tick::from_seconds_f64(2.0));
        let mut info = generator.info().clone();
        info.kind = filmcraft_media::MediaKind::Movie;
        info.audio_streams.push(info.audio_streams[0].clone());
        info.audio_streams[1].codec = "second-stream-fixture".into();
        let source = Arc::new(Movie { info: info.clone(), calls: Mutex::default() });
        let mut project = (*s.project).clone();
        let item = project.add_item("two-stream movie", Label::Iris, ItemKind::Media(MediaClip {
            media: MediaRef::File { path: "/imported-movie.mov".into() }, info,
            interpret: Default::default(), mark_in: None, mark_out: None, markers: vec![], offline: false,
            proxy: Some(MediaRef::File { path: "/never-read-this-proxy.mov".into() }), identity: None,
        }), None);
        s.project = Arc::new(project);
        s.media.insert(item, source.clone());
        s.media.set_use_proxies(true);
        let selected = read(&s, &json!({"item":item.0,"audioStream":1,"startSeconds":0.5,"durationSeconds":0.25,"sampleRate":24000})).unwrap();
        assert!((rms(&selected) - 0.3 * 2.0 * std::f64::consts::FRAC_1_SQRT_2).abs() < 0.0001);
        assert_eq!(selected["source"]["kind"], "Movie");
        assert_eq!(selected["audioStream"]["index"], 1);
        assert_eq!(selected["audioStream"]["codec"], "second-stream-fixture");
        assert_eq!(selected["availableAudioStreams"].as_array().unwrap().len(), 2);
        assert_eq!(selected["mediaStatus"]["proxyUsed"], false);
        let calls = source.calls.lock().unwrap();
        assert_eq!(calls[0], (1, 12000, 4096, 24000));
        assert!(calls.iter().all(|(stream, _, _, _)| *stream == 1));
        drop(calls);
        let default = read(&s, &json!({"item":item.0,"startSeconds":0.5,"durationSeconds":0.25})).unwrap();
        assert!((rms(&default) - 0.1 * 2.0 * std::f64::consts::FRAC_1_SQRT_2).abs() < 0.0001);
    }
    #[test]
    fn audio_read_imported_rejects_invalid_selectors_and_nonmedia_and_flags_offline_original() {
        let (mut s, item, _) = fixture();
        let sequence = s.state.active_sequence.unwrap();
        for params in [
            json!({"item":item.0,"track":"A1"}), json!({"audioStream":0}), json!({"item":0}), json!({"item":1.5}), json!({"item":"1"}),
            json!({"item":999999}), json!({"item":sequence.0}), json!({"item":item.0,"audioStream":-1}), json!({"item":item.0,"audioStream":0.5}),
            json!({"item":item.0,"audioStream":1}), json!({"item":item.0,"audioStream":"0"}),
        ] {
            let mut p = params; p["startSeconds"] = json!(0); p["durationSeconds"] = json!(0.1);
            assert!(read(&s, &p).is_err(), "{p}");
        }
        for (start, duration) in [(-1.0, 1.0), (2.0, 1.0), (0.0, 31.0), (0.0, 0.0), (0.0, 0.0000001)] {
            assert!(read(&s, &json!({"item":item.0,"startSeconds":start,"durationSeconds":duration})).is_err());
        }
        let mut project = (*s.project).clone();
        let subclip = project.add_item("subclip", filmcraft_project::Label::Iris, filmcraft_project::ItemKind::Subclip { parent: item, range: filmcraft_time::TimeRange::new(Tick::ZERO, Tick::from_seconds_f64(1.0)), restrict_trims: true }, None);
        let mut silent = project.item(item).unwrap().as_media().unwrap().clone();
        silent.info.audio_streams.clear();
        let no_audio = project.add_item("silent movie", filmcraft_project::Label::Iris, filmcraft_project::ItemKind::Media(silent), None);
        s.project = Arc::new(project);
        for id in [subclip, no_audio] { assert!(read(&s, &json!({"item":id.0,"startSeconds":0,"durationSeconds":0.1})).is_err()); }
        s.execute("media.makeOffline", json!({"items":[item.0]})).unwrap();
        s.media.set_use_proxies(true);
        let offline = read(&s, &json!({"item":item.0,"startSeconds":0,"durationSeconds":0.1})).unwrap();
        assert_eq!(offline["offlineMedia"][0]["item"], item.0);
        assert_eq!(offline["mediaStatus"], json!({"original":"offline","proxyUsed":false}));
    }
    #[test]
    fn audio_read_fixture_ranges_pcm_and_read_only() {
        let (mut s, item, clip) = fixture();
        s.state.source_item = Some(item);
        s.state.source_playhead = Tick::from_seconds_f64(0.8);
        s.state.source_history = vec![item];
        s.state.selection = vec![clip];
        s.set_playhead(Tick::from_seconds_f64(0.5));
        let state = serde_json::to_value(&s.state).unwrap();
        let project = s.project.clone();
        let history = s.execute("history.list", json!({})).unwrap();
        let revision = s.revision;
        let journal = s.journal.clone();
        let value = s.execute("audio.read", json!({"startSeconds":0.25,"durationSeconds":0.25,"track":"A1","sampleRate":24000})).unwrap();
        assert_eq!(value["frameCount"], 6000);
        assert_eq!(samples(&value).len(), 6000);
        assert_eq!(value["actualRange"]["startSeconds"], 0.25);
        assert_eq!(value["track"]["label"], "A1");
        assert_eq!(value["signalPath"], "track_input_pre_mixer");
        // BS.775 stereo to mono: M = L/sqrt(2) + R/sqrt(2).
        let expected = 0.1 * 2.0 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((rms(&value) - expected).abs() < 0.0001, "known PCM amplitude");
        assert_eq!(value["offlineMedia"], json!([]));
        assert!(Arc::ptr_eq(&project, &s.project));
        assert_eq!(serde_json::to_value(&s.state).unwrap(), state);
        assert_eq!(s.revision, revision);
        assert_eq!(s.journal, journal);
        assert_eq!(s.execute("history.list", json!({})).unwrap(), history);
        read(&s, &json!({"item":item.0,"startSeconds":0.7,"durationSeconds":0.2})).unwrap();
        assert_eq!(serde_json::to_value(&s.state).unwrap(), state);
        assert!(Arc::ptr_eq(&project, &s.project));
        assert_eq!(s.revision, revision);
        assert_eq!(s.journal, journal);
        assert_eq!(s.execute("history.list", json!({})).unwrap(), history);
        let clamped = read(&s, &json!({"startSeconds":1.9,"durationSeconds":1})).unwrap();
        assert!((clamped["actualRange"]["endSeconds"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        assert_eq!(clamped["requestedRange"]["endSeconds"], 2.9);
    }
    #[test]
    fn audio_read_track_input_vs_mix_and_clip_processing() {
        let (mut s, _, clip) = fixture();
        s.execute("mixer.setStrip", json!({"strip":"A1","muted":true})).unwrap();
        let params = json!({"startSeconds":0.1,"durationSeconds":0.1});
        let mixed = read(&s, &params).unwrap();
        assert_eq!(mixed["signalPath"], "sequence_mix");
        assert!(rms(&mixed) < 0.0001, "mute acts on the mix");
        let track = read(&s, &json!({"startSeconds":0.1,"durationSeconds":0.1,"track":"A1"})).unwrap();
        assert!(rms(&track) > 0.09, "track input precedes track mute");
        s.execute("effects.apply", json!({"clips":[clip.0],"effect":"Mute"})).unwrap();
        let effect = s.active_sequence().unwrap().find_item(clip).unwrap().1.effects.iter().position(|e| e.effect == "mute").unwrap();
        s.execute("effects.setParam", json!({"clip":clip.0,"effect":effect,"param":"mute","value":true})).unwrap();
        let muted = read(&s, &json!({"startSeconds":0.1,"durationSeconds":0.1,"track":"A1"})).unwrap();
        assert!(rms(&muted) < 0.0001, "clip effects are rendered");
    }
    #[test]
    fn audio_read_source_offset_speed_and_silence() {
        let (mut s, _, clip) = fixture();
        let sid = s.state.active_sequence.unwrap();
        let mut project = (*s.project).clone();
        let item = project.sequence_mut(sid).unwrap().audio_tracks[0].items.iter_mut().find(|i| i.id == clip).unwrap();
        item.start = Tick::from_seconds_f64(1.0);
        item.source_in = Tick::from_seconds_f64(0.5);
        item.speed = 2.0;
        item.duration = Tick::from_seconds_f64(0.75);
        s.project = Arc::new(project);
        let quiet = read(&s, &json!({"startSeconds":0,"durationSeconds":0.5,"track":"A1"})).unwrap();
        assert!(rms(&quiet) < 0.0001);
        let later = read(&s, &json!({"startSeconds":1.4,"durationSeconds":0.1,"track":"A1"})).unwrap();
        let expected = 0.4 * 2.0 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((rms(&later) - expected).abs() < 0.0001, "timeline 1.4 maps to source 1.3");
    }
    #[test]
    fn audio_read_fractional_start_maximum_duration_stays_bounded() {
        let (s, _, _) = fixture_seconds(31);
        for rate in [16_000, 24_000] {
            let value = read(&s, &json!({"startSeconds":0.123456789,"durationSeconds":30,"sampleRate":rate,"track":"A1"})).unwrap();
            let frames = value["frameCount"].as_u64().unwrap();
            assert_eq!(frames, rate * 30);
            assert_eq!(samples(&value).len() as u64, frames);
            assert!(value["actualRange"]["durationSeconds"].as_f64().unwrap() <= 30.0);
            assert!(value["actualRange"]["endSeconds"].as_f64().unwrap() <= 31.0);
        }
    }
    #[test]
    fn audio_read_invalid_bounds_track_and_offline() {
        let (mut s, item, _) = fixture();
        for params in [json!({}),json!({"startSeconds":-1,"durationSeconds":1}),json!({"startSeconds":0,"durationSeconds":31}),json!({"startSeconds":0,"durationSeconds":0}),json!({"startSeconds":2,"durationSeconds":1}),json!({"startSeconds":0,"durationSeconds":1,"sampleRate":48000}),json!({"startSeconds":0,"durationSeconds":1,"track":"V1"}),json!({"startSeconds":0,"durationSeconds":1,"track":999999})] {
            assert!(read(&s, &params).is_err(), "{params}");
        }
        let video = s.active_sequence().unwrap().video_tracks[0].id.0;
        assert!(read(&s, &json!({"startSeconds":0,"durationSeconds":1,"track":video})).is_err());
        let audio = s.active_sequence().unwrap().audio_tracks[0].id.0;
        assert!(read(&s, &json!({"startSeconds":0,"durationSeconds":1,"track":audio})).is_ok());
        s.execute("media.makeOffline", json!({"items":[item.0]})).unwrap();
        let offline = read(&s, &json!({"startSeconds":0,"durationSeconds":0.1,"track":"A1"})).unwrap();
        assert_eq!(offline["offlineMedia"][0]["item"], item.0);
        assert!(rms(&offline) < 0.0001);
    }
}
