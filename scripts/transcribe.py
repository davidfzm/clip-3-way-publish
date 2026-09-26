"""Local speech transcription. Only --download accesses the network."""
import argparse
import json
import os
import sys

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--audio')
    parser.add_argument('--language', default='es')
    args = parser.parse_args()
    from faster_whisper import WhisperModel
    if args.download:
        from faster_whisper.utils import download_model
        download_model('base', output_dir=args.model_dir)
        emit({'ready': True})
        return
    ready = os.path.isfile(os.path.join(args.model_dir, 'model.bin'))
    if args.check:
        emit({'ready': ready})
        return
    if not ready:
        raise RuntimeError('Falta el modelo local. Ejecuta npm run setup:subtitles.')
    model = WhisperModel(args.model_dir, device='cpu', compute_type='int8',
                         cpu_threads=min(8, os.cpu_count() or 4), local_files_only=True)
    emit({'progress': 5, 'message': 'Transcribiendo voz en este equipo'})
    segments, info = model.transcribe(args.audio, language=None if args.language == 'auto' else args.language,
                                      word_timestamps=True, vad_filter=True, beam_size=5,
                                      condition_on_previous_text=False)
    cues = []
    for segment in segments:
        if segment.no_speech_prob > 0.8 and segment.avg_logprob < -1:
            continue
        group = []
        def flush():
            if group:
                text = ''.join(word.word for word in group).strip()
                if text:
                    cues.append({'start': round(group[0].start, 3), 'end': round(group[-1].end, 3), 'text': text})
                group.clear()
        for word in segment.words or []:
            if group and (len(group) >= 5 or len(''.join(w.word for w in group)) + len(word.word) > 34
                          or word.start - group[-1].end > 0.5):
                flush()
            group.append(word)
            if word.word.rstrip().endswith(('.', '!', '?', ';', ':')):
                flush()
        flush()
        if not segment.words and segment.text.strip():
            cues.append({'start': round(segment.start, 3), 'end': round(segment.end, 3), 'text': segment.text.strip()})
        emit({'progress': min(98, round(segment.end / max(info.duration, 1) * 100)), 'message': 'Transcribiendo voz en este equipo'})
    emit({'result': {'language': info.language, 'segments': cues}})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'error': str(error)[:400]})
        sys.exit(1)
