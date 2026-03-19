/**
 * VoiceService — TUI voice support using system audio tools (sox/rec/afplay)
 * and the Reactory Speech Service for TTS/STT.
 *
 * Audio capture: `rec` (sox) for recording
 * Audio playback: `afplay` (macOS) / `aplay` (Linux)
 * TTS: SpeechService@1.0.0 via DI or HTTP fallback to Python microservice
 * STT: SpeechService@1.0.0 via DI or HTTP fallback to Python microservice
 */
import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { SpeechAdapterOptions } from "../types";
import logger from "@reactory/server-core/logging";

export interface VoiceServiceEvents {
  "recording:start": () => void;
  "recording:stop": (audioBuffer: Buffer) => void;
  "recording:error": (error: Error) => void;
  "playback:start": () => void;
  "playback:stop": () => void;
  "playback:error": (error: Error) => void;
  "transcription": (text: string) => void;
  "transcription:error": (error: Error) => void;
  "synthesis:ready": (audioBuffer: Buffer) => void;
  "synthesis:error": (error: Error) => void;
}

export class VoiceService extends EventEmitter {
  private recordProcess: ChildProcess | null = null;
  private playProcess: ChildProcess | null = null;
  private speechService: any = null;
  private speechBaseUrl: string;
  private defaultVoice: string;
  private tempDir: string;
  private platform: NodeJS.Platform;

  constructor(options: SpeechAdapterOptions = {}) {
    super();
    this.platform = os.platform();
    this.tempDir = os.tmpdir();
    this.defaultVoice = options.defaultVoice || "af_heart";
    this.speechBaseUrl =
      options.baseUrl ||
      process.env.REACTORY_SPEECH_SERVICE_URL ||
      "http://localhost:8765";

    if (options.context) {
      try {
        this.speechService = options.context.getService(
          "speech.SpeechService@1.0.0"
        );
      } catch {
        logger.warn("[VoiceService] SpeechService not available via DI");
      }
    }
  }

  // ── Recording ──────────────────────────────────────────────────────

  /**
   * Start recording audio via `rec` (sox).
   * Saves to a temp WAV file.
   */
  startRecording(): string {
    if (this.recordProcess) {
      this.stopRecording();
    }

    const filePath = path.join(
      this.tempDir,
      `reactor_rec_${Date.now()}.wav`
    );

    // Use `rec` from sox to record audio
    this.recordProcess = spawn("rec", [
      filePath,
      "rate",
      "24000",
      "channels",
      "1",
      "silence",
      "1",
      "0.1",
      "3%",  // start recording after 0.1s of sound above 3%
      "1",
      "3.0",
      "3%",  // stop after 3s of silence below 3%
    ]);

    this.recordProcess.on("error", (err) => {
      this.emit("recording:error", err);
      this.recordProcess = null;
    });

    this.recordProcess.on("close", () => {
      this.recordProcess = null;
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        this.emit("recording:stop", buffer);
        // Clean up temp file
        fs.unlinkSync(filePath);
      }
    });

    this.emit("recording:start");
    return filePath;
  }

  /**
   * Stop the current recording session.
   */
  stopRecording(): void {
    if (this.recordProcess) {
      this.recordProcess.kill("SIGTERM");
      this.recordProcess = null;
    }
  }

  get isRecording(): boolean {
    return this.recordProcess !== null;
  }

  // ── Playback ───────────────────────────────────────────────────────

  /**
   * Play an audio buffer using the system audio player.
   */
  async playAudio(audioBuffer: Buffer): Promise<void> {
    // Write buffer to temp file
    const filePath = path.join(
      this.tempDir,
      `reactor_play_${Date.now()}.wav`
    );
    fs.writeFileSync(filePath, audioBuffer);

    return new Promise((resolve, reject) => {
      const cmd = this.platform === "darwin" ? "afplay" : "aplay";
      this.playProcess = spawn(cmd, [filePath]);

      this.emit("playback:start");

      this.playProcess.on("error", (err) => {
        this.emit("playback:error", err);
        this.playProcess = null;
        this.cleanupTemp(filePath);
        reject(err);
      });

      this.playProcess.on("close", () => {
        this.playProcess = null;
        this.emit("playback:stop");
        this.cleanupTemp(filePath);
        resolve();
      });
    });
  }

  /**
   * Stop current audio playback.
   */
  stopPlayback(): void {
    if (this.playProcess) {
      this.playProcess.kill("SIGTERM");
      this.playProcess = null;
    }
  }

  get isPlaying(): boolean {
    return this.playProcess !== null;
  }

  // ── TTS (Text-to-Speech) ──────────────────────────────────────────

  /**
   * Synthesize text to audio using the speech service.
   */
  async synthesize(
    text: string,
    options?: { voice?: string; speed?: number }
  ): Promise<Buffer> {
    const voice = options?.voice || this.defaultVoice;
    const speed = options?.speed || 1.0;

    // Try DI service first
    if (this.speechService) {
      try {
        const result = await this.speechService.synthesize(text, {
          voice,
          speed,
        });
        this.emit("synthesis:ready", result.audioBuffer);
        return result.audioBuffer;
      } catch (err: any) {
        logger.warn(
          `[VoiceService] DI TTS failed, trying HTTP: ${err.message}`
        );
      }
    }

    // HTTP fallback
    return this.httpSynthesize(text, voice, speed);
  }

  private async httpSynthesize(
    text: string,
    voice: string,
    speed: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ text, voice, speed });
      const url = new URL("/api/tts/synthesize", this.speechBaseUrl);

      const req = http.request(
        url.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            if (res.statusCode === 200) {
              this.emit("synthesis:ready", buffer);
              resolve(buffer);
            } else {
              const err = new Error(
                `TTS failed: HTTP ${res.statusCode}`
              );
              this.emit("synthesis:error", err);
              reject(err);
            }
          });
        }
      );

      req.on("error", (err) => {
        this.emit("synthesis:error", err);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  // ── STT (Speech-to-Text) ──────────────────────────────────────────

  /**
   * Transcribe audio buffer to text using the speech service.
   */
  async transcribe(
    audioBuffer: Buffer,
    options?: { language?: string }
  ): Promise<string> {
    // Try DI service first
    if (this.speechService) {
      try {
        const result = await this.speechService.transcribe(
          audioBuffer,
          options
        );
        this.emit("transcription", result.text);
        return result.text;
      } catch (err: any) {
        logger.warn(
          `[VoiceService] DI STT failed, trying HTTP: ${err.message}`
        );
      }
    }

    // HTTP fallback — multipart form upload
    return this.httpTranscribe(audioBuffer, options?.language);
  }

  private async httpTranscribe(
    audioBuffer: Buffer,
    language?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const boundary = `----ReactorTUI${Date.now()}`;
      const url = new URL("/api/stt/transcribe", this.speechBaseUrl);

      const parts: Buffer[] = [];

      // File part
      parts.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
            `Content-Type: audio/wav\r\n\r\n`
        )
      );
      parts.push(audioBuffer);
      parts.push(Buffer.from("\r\n"));

      // Language param (optional)
      if (language) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="language"\r\n\r\n` +
              `${language}\r\n`
          )
        );
      }

      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const req = http.request(
        url.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const result = JSON.parse(data);
              if (res.statusCode === 200 && result.text) {
                this.emit("transcription", result.text);
                resolve(result.text);
              } else {
                const err = new Error(
                  result.error || `STT failed: HTTP ${res.statusCode}`
                );
                this.emit("transcription:error", err);
                reject(err);
              }
            } catch {
              reject(new Error(`Invalid STT response: ${data.substring(0, 200)}`));
            }
          });
        }
      );

      req.on("error", (err) => {
        this.emit("transcription:error", err);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────

  /**
   * Check if system audio tools are available.
   */
  async checkDependencies(): Promise<{
    rec: boolean;
    player: boolean;
    speechService: boolean;
  }> {
    const recAvailable = await this.commandExists("rec");
    const playerCmd =
      this.platform === "darwin" ? "afplay" : "aplay";
    const playerAvailable = await this.commandExists(playerCmd);
    const speechAvailable = this.speechService !== null;

    return {
      rec: recAvailable,
      player: playerAvailable,
      speechService: speechAvailable,
    };
  }

  private commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("which", [cmd]);
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  }

  private cleanupTemp(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Clean up all processes.
   */
  destroy(): void {
    this.stopRecording();
    this.stopPlayback();
    this.removeAllListeners();
  }
}
