import type { DetectionResult, FsProbe, StackDetection, StackDetector } from '@pomni/core';
import { gradleDetector } from './gradle.js';
import { goDetector, makeDetector, rustDetector } from './misc.js';
import { nodeDetector } from './node.js';
import { pythonDetector } from './python.js';

export { goDetector, gradleDetector, makeDetector, nodeDetector, pythonDetector, rustDetector };

/** Order matters: the first detector that recognises the directory wins. */
export const DEFAULT_DETECTORS: StackDetector[] = [
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  // Before `make`: a Gradle project often ships a convenience Makefile that wraps the
  // wrapper, and the wrapper is the more accurate answer.
  gradleDetector,
  makeDetector,
];

/**
 * Adding support for a new stack means adding a detector to this list. No consumer of
 * `StackDetection` changes, which is the whole point of the capability abstraction.
 */
export class DetectorRegistry implements StackDetection {
  constructor(
    private readonly fs: FsProbe,
    private readonly detectors: StackDetector[] = DEFAULT_DETECTORS,
  ) {}

  async detect(dir: string): Promise<DetectionResult | null> {
    for (const detector of this.detectors) {
      const result = await detector.detect(dir, this.fs);
      if (result) return result;
    }
    return null;
  }

  /** Every match, not just the first. Useful for polyglot repos in a later milestone. */
  async detectAll(dir: string): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    for (const detector of this.detectors) {
      const result = await detector.detect(dir, this.fs);
      if (result) results.push(result);
    }
    return results;
  }
}
