import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private readonly ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  private readonly model = process.env.OLLAMA_NL_MODEL ?? 'exaone3.5:latest';

  async onModuleInit() {
    // Check if python and faster-whisper are available
    try {
      await execAsync('python3 -c "from faster_whisper import WhisperModel"');
      this.logger.log('Faster-Whisper dependency verified.');
    } catch (err) {
      this.logger.warn('Faster-Whisper not found in python3. STT might fail. Please run: pip install faster-whisper');
    }
  }

  /**
   * STT using faster-whisper via python bridge
   */
  async transcribe(file: Express.Multer.File): Promise<{ text: string }> {
    const tempPath = path.join(__dirname, `../../temp_${Date.now()}.wav`);
    fs.writeFileSync(tempPath, file.buffer);

    try {
      // Use a small python script to run faster-whisper
      const pyScript = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("base", device="cpu", compute_type="float32")
segments, info = model.transcribe("${tempPath}", beam_size=5)
print(" ".join([s.text for s in segments]).strip())
      `;

      const { stdout, stderr } = await execAsync(`python3 -c '${pyScript}'`);

      if (stderr && !stderr.includes('Thread')) { // Filter out non-error logs
        this.logger.error(`STT Python Error: ${stderr}`);
      }

      return { text: stdout.trim() };
    } catch (err) {
      this.logger.error('STT failed', err);
      throw new Error('Speech-to-Text processing failed');
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  /**
   * Ask Ollama (EXAONE 3.0)
   */
  async ask(text: string): Promise<string> {
    try {
      const response = await axios.post(`${this.ollamaUrl}/api/generate`, {
        model: this.model,
        prompt: text,
        stream: false,
        keep_alive: -1,
      });

      return response.data.response;
    } catch (err: any) {
      this.logger.error(`Ollama link failed (${this.ollamaUrl}): ${err.message}`);
      throw new Error('AI Assistant connection failed');
    }
  }
}
