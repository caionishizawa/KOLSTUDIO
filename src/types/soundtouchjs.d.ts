declare module 'soundtouchjs' {
  export class SoundTouch {
    constructor()
    rate: number
    tempo: number
    pitch: number
    pitchSemitones: number
    clear(): void
  }
  export interface SampleSource {
    extract(target: Float32Array, numFrames: number, position: number): number
  }
  export class SimpleFilter {
    constructor(source: SampleSource, pipe: SoundTouch, callback?: () => void)
    extract(target: Float32Array, numFrames: number): number
    position: number
    sourcePosition: number
    clear(): void
  }
}
