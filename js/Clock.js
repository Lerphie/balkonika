// Clock.js — fixed simulation time and seeded randomness; checked with strict TypeScript.
// Rendering stays independent from simulation; background time is discarded explicitly.

/** @typedef {{hz?:number, maxSteps?:number, seed?:number}} ArcClockOptions */
/** @typedef {{hz:number,tick:number,accumulator:number,rngState:number,droppedSeconds:number}} ArcClockState */
class ArcClock {
    /** @param {ArcClockOptions} [options] */
    constructor(options = {}) {
        this.hz = options.hz == null ? 60 : options.hz;
        this.maxSteps = options.maxSteps == null ? 8 : options.maxSteps;
        if (!Number.isFinite(this.hz) || this.hz < 1 || this.hz > 240) throw new RangeError('CLOCK_HZ_INVALID');
        if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) throw new RangeError('CLOCK_STEPS_INVALID');
        this.tick = 0;
        this.accumulator = 0;
        this.droppedSeconds = 0;
        this.rngState = (options.seed == null ? 1 : options.seed) >>> 0 || 1;
    }
    get dt() { return 1 / this.hz; }
    get time() { return this.tick / this.hz; }
    random() {
        let x = this.rngState;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.rngState = x >>> 0;
        return this.rngState / 4294967296;
    }
    /** @param {number} elapsed @param {(dt:number)=>void|boolean} step */
    advance(elapsed, step) {
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError('CLOCK_ELAPSED_INVALID');
        const budget = this.maxSteps * this.dt;
        const accepted = Math.min(elapsed, budget);
        this.droppedSeconds += elapsed - accepted;
        this.accumulator += accepted;
        let count = 0;
        while (this.accumulator + 1e-12 >= this.dt && count < this.maxSteps) {
            this.accumulator = Math.max(0, this.accumulator - this.dt);
            this.tick++;
            const proceed = step(this.dt);
            count++;
            if (proceed === false) break;
        }
        return count;
    }
    /** @param {number} count @param {(dt:number)=>void|boolean} step */
    advanceTicks(count, step) {
        if (!Number.isInteger(count) || count < 0 || count > 36000) throw new RangeError('TICK_COUNT_INVALID');
        for (let i = 0; i < count; i++) { this.tick++; if (step(this.dt) === false) break; }
        return this.tick;
    }
    snapshot() {
        return { hz: this.hz, tick: this.tick, accumulator: this.accumulator, rngState: this.rngState, droppedSeconds: this.droppedSeconds };
    }
    /** @param {ArcClockState} state */
    restore(state) {
        if (!state || state.hz !== this.hz || !Number.isSafeInteger(state.tick) || state.tick < 0 ||
            !Number.isInteger(state.rngState) || state.rngState <= 0 || state.rngState > 0xffffffff ||
            !Number.isFinite(state.accumulator) || state.accumulator < 0 || state.accumulator >= this.dt + 1e-9 ||
            !Number.isFinite(state.droppedSeconds) || state.droppedSeconds < 0) throw new Error('CLOCK_SNAPSHOT_INVALID');
        this.tick = state.tick; this.accumulator = state.accumulator;
        this.rngState = state.rngState; this.droppedSeconds = state.droppedSeconds;
    }
}
