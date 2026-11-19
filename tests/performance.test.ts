import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
const exe =
  process.env.FFMPEG_TEST_PATH ||
  (fs.existsSync("/usr/bin/ffmpeg")
    ? "/usr/bin/ffmpeg"
    : path.resolve("node_modules/node-av/binary/ffmpeg"));
(fs.existsSync(exe) ? test : test.skip)(
  "generated-media FFmpeg concurrency at 2, 4 and 8 processes",
  async () => {
    const results: any[] = [];
    for (const count of [2, 4, 8]) {
      const start = performance.now();
      const processes = Array.from({ length: count }, () =>
        Bun.spawn(
          [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x90:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.5",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-f",
            "null",
            "-",
          ],
          { stdout: "ignore", stderr: "pipe" },
        ),
      );
      const codes = await Promise.all(
        processes.map(async (p) => {
          const err = await new Response(p.stderr).text();
          const code = await p.exited;
          expect(err).toBe("");
          return code;
        }),
      );
      expect(codes.every((code) => code === 0)).toBe(true);
      results.push({
        processes: count,
        wallMs: Math.round(performance.now() - start),
        supervisorRSS: process.memoryUsage().rss,
        ffmpegCpuMicroseconds: processes.reduce(
          (sum, p) => sum + Number(p.resourceUsage()?.cpuTime.total || 0),
          0,
        ),
        sumOfPeakFfmpegRSS: processes.reduce(
          (sum, p) => sum + Number(p.resourceUsage()?.maxRSS || 0),
          0,
        ),
      });
    }
    console.info(
      "Synthetic FFmpeg concurrency (not Discord throughput): " +
        JSON.stringify(results),
    );
  },
  30000,
);
