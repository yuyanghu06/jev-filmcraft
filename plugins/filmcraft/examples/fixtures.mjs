// Procedural fixtures created by this project. No external or copyrighted footage.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function makeFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const width = 320, height = 180, stride = width * 3;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 54 + y * stride + x * 3;
    bmp[i] = Math.round(90 + 100 * y / height);
    bmp[i + 1] = Math.round(40 + 180 * x / width);
    bmp[i + 2] = x > 80 && x < 240 && y > 40 && y < 140 ? 235 : 35;
  }
  const sampleRate = 48000, samples = sampleRate * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) wav.writeInt16LE(Math.round(6000 * Math.sin(n / sampleRate * 2 * Math.PI * 440)), 44 + n * 2);
  const image = join(directory, 'generated-card.bmp'), audio = join(directory, 'generated-tone.wav');
  await writeFile(image, bmp); await writeFile(audio, wav);
  return { image, audio };
}
