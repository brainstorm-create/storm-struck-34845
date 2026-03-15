#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const youtubeId = 'dQw4w9WgXcQ'; 
const bufferDir = path.resolve('./buffer_test');
const playlistPath = path.join(bufferDir, 'local.m3u8');
const maxSegments = 10;

// Log helpers simplificados para o teste
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const warn = m => console.warn(`[${new Date().toLocaleTimeString()}] ⚠️ ${m}`);

async function getStreamUrls(youtubeId) {
    let retries = 3;
    while (retries > 0) {
        try {
            log(`[Extractor] Pegando links de ${youtubeId} via yt-dlp...`);
            const args = [
                '--no-warnings',
                '--extractor-args', 'youtube:player-client=web_embedded',
                '-f', 'bestvideo[height<=720]+bestaudio/best',
                '-g', '--',
                youtubeId.startsWith('http') ? youtubeId : `https://www.youtube.com/watch?v=${youtubeId}`
            ];

            const stdout = await new Promise((resolve, reject) => {
                const proc = spawn('yt-dlp', args);
                let out = '', errOut = '', done = false;
                const timer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    proc.kill('SIGKILL');
                    reject(new Error('yt-dlp timeout'));
                }, 60000);
                proc.stdout.on('data', d => out += d);
                proc.stderr.on('data', d => errOut += d);
                proc.on('close', code => {
                    done = true;
                    clearTimeout(timer);
                    if (code !== 0) reject(new Error(errOut.trim() || 'Status não-zero'));
                    else resolve(out);
                });
            });

            const out = stdout.trim().split('\n').filter(Boolean);
            if (!out.length) throw new Error('Vazio');
            return { videoUrl: out[0], audioUrl: out[1] || null, merged: out.length === 1 };
        } catch (e) {
            retries--;
            warn(`[Extractor] Falhou: ${e.message}. Retentativas: ${retries}`);
            if (retries === 0) throw e;
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function main() {
    log(`[Test] Iniciando Sliding Buffer Test...`);
    if (!fs.existsSync(bufferDir)) fs.mkdirSync(bufferDir, { recursive: true });

    const stream = await getStreamUrls(youtubeId);
    log(`[Test] URLs obtidas. Merged: ${stream.merged}`);

    // Construção dinâmica do input do FFmpeg
    const ffmpegArgs = [
        "-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1",
        "-i", stream.videoUrl
    ];

    if (!stream.merged && stream.audioUrl) {
        ffmpegArgs.push("-i", stream.audioUrl);
    }

    // Configuração do HLS Segmenter
    ffmpegArgs.push(
        "-c", "copy",
        "-map", "0:v",
        "-map", stream.merged ? "0:a" : "1:a",
        "-f", "hls",
        "-hls_time", "5",
        "-hls_list_size", String(maxSegments),
        "-hls_flags", "delete_segments+append_list", 
        "-hls_segment_filename", path.join(bufferDir, 'seg_%03d.ts'),
        playlistPath
    );

    log(`[Test] Rodando FFmpeg...`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

    const monitor = setInterval(() => {
        try {
            const files = fs.readdirSync(bufferDir).filter(f => f.endsWith('.ts'));
            log(`[Monitor] Buffer: ${files.length} segmentos. Manifest: ${fs.existsSync(playlistPath) ? 'OK' : 'Pendente'}`);
        } catch {}
    }, 5000);

    ffmpeg.on('close', (code) => {
        clearInterval(monitor);
        log(`[Test] Finalizado (Code: ${code})`);
        process.exit(code);
    });
}

main().catch(e => {
    console.error(`[Fatal] ${e.stack}`);
    process.exit(1);
});
