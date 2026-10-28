/**
 * Signed Q32.32 arithmetic for the optional sampled-gradient navigation helper.
 * Finite kernels and polynomial defaults follow the pinned native numeric bodies.
 * Number conversion is an explicit boundary adapter, not an IL2CPP initializer.
 * @typedef {{x: bigint, y: bigint}} FixedRVOVector2
 */
class FixedRVOQ32 {
    static ZERO = 0n;
    static ONE = 0x100000000n;
    static EPS = 1n;
    static COMPARISON_EPS = 43n;
    static C01 = 0x19999999n;
    static C02 = 0x33333333n;
    static C03 = 0x4cccccccn;
    static C005 = 0xcccccccn;
    static C05 = 0x80000000n;
    static C1EM3 = 0x418937n;
    static C1EM4 = 0x68db8n;
    static C1EM5 = 0xa7c5n;
    static PI = 0x3243f6a88n;
    static HALF_PI = 0x1921fb544n;
    static TWO_PI = 0x6487ed511n;
    static MAX = 0x7ffffffffffffffen;
    static MIN = -0x7ffffffffffffffen;
    static NAN = -0x7fffffffffffffffn;
    static POSITIVE_INFINITY = 0x7fffffffffffffffn;
    static NEGATIVE_INFINITY = -0x8000000000000000n;

    /** @param {bigint} value @returns {bigint} */
    static wrap(value) { return BigInt.asIntN(64, value); }
    /** @param {bigint} value @returns {bigint} */
    static _i32(value) { return BigInt.asIntN(32, value); }
    /** @param {number} value @returns {bigint} */
    static fromNumber(value) {
        if (!Number.isFinite(value) || value <= -2147483648 || value >= 2147483648) {
            throw new RangeError('FIXED_RVO_NUMBER_RANGE');
        }
        // Boundary conversion truncates toward zero; native literals stay explicit.
        const raw = BigInt(Math.trunc(value * 4294967296));
        if (raw < this.MIN || raw > this.MAX) throw new RangeError('FIXED_RVO_NUMBER_RANGE');
        return raw;
    }
    /** @param {bigint} value @returns {number} */
    static toNumber(value) {
        if (value === this.NAN) return NaN;
        if (value === this.POSITIVE_INFINITY) return Infinity;
        if (value === this.NEGATIVE_INFINITY) return -Infinity;
        return Number(value) / 4294967296;
    }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static add(a, b) {
        if (this.isFinite(a) && this.isFinite(b)) return this.wrap(a + b);
        if (a === this.NAN || b === this.NAN) return this.NAN;
        if (this.isFinite(a)) return b;
        if (this.isFinite(b)) return a;
        return a === b ? a : this.NAN;
    }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static sub(a, b) {
        if (this.isFinite(a) && this.isFinite(b)) return this.wrap(a - b);
        if (a === this.NAN || b === this.NAN) return this.NAN;
        if (this.isFinite(a)) return this.neg(b);
        if (this.isFinite(b)) return a;
        return a === b ? this.NAN : a;
    }
    /** @param {bigint} a @returns {bigint} */
    static neg(a) {
        if (a === this.NAN) return this.NAN;
        if (a === this.NEGATIVE_INFINITY) return this.POSITIVE_INFINITY;
        if (a === this.POSITIVE_INFINITY) return this.NEGATIVE_INFINITY;
        return this.wrap(-a);
    }
    /** @param {bigint} a @returns {bigint} */
    static abs(a) { return a < 0n ? this.neg(a) : a; }
    /** @param {bigint} a @returns {boolean} */
    static isFinite(a) { return a >= this.MIN && a <= this.MAX; }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static eq(a, b) {
        if (a === this.NAN || b === this.NAN) return false;
        const difference = this.wrap(a - b);
        return difference >= -this.COMPARISON_EPS && difference <= this.COMPARISON_EPS;
    }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static ne(a, b) { return !this.eq(a, b); }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static lt(a, b) { return a !== this.NAN && b !== this.NAN && a < b && !this.eq(a, b); }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static gt(a, b) { return a !== this.NAN && b !== this.NAN && a > b && !this.eq(a, b); }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static le(a, b) { return a !== this.NAN && b !== this.NAN && (a < b || this.eq(a, b)); }
    /** @param {bigint} a @param {bigint} b @returns {boolean} */
    static ge(a, b) { return a !== this.NAN && b !== this.NAN && (a > b || this.eq(a, b)); }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static min(a, b) { return this.lt(a, b) ? a : b; }
    /** @param {bigint} value @returns {bigint} */
    static clamp01(value) {
        if (this.gt(value, this.ONE)) return this.ONE;
        if (this.lt(value, this.ZERO)) return this.ZERO;
        return value;
    }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static rawMin(a, b) { return a < b ? a : b; }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static max(a, b) { return this.gt(a, b) ? a : b; }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static rawMax(a, b) { return a > b ? a : b; }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static mul(a, b) {
        if (!this.isFinite(a) || !this.isFinite(b)) {
            if (a === this.NAN || b === this.NAN || a === 0n || b === 0n) return this.NAN;
            return (a < 0n) !== (b < 0n) ? this.NEGATIVE_INFINITY : this.POSITIVE_INFINITY;
        }
        // Native 32-bit limb products floor negative results and wrap the final sum.
        return this.wrap((a * b) >> 32n);
    }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static div(a, b) {
        if (a === this.NAN || b === this.NAN) return this.NAN;
        if (!this.isFinite(b)) return this.isFinite(a) ? 0n : this.NAN;
        if (!this.isFinite(a)) return b < 0n ? this.neg(a) : a;
        if (b === 0n) return a === 0n ? this.NAN : a > 0n ? this.POSITIVE_INFINITY : this.NEGATIVE_INFINITY;
        // Native finite long division computes 33 bits, then adds one and halves.
        const doubled = BigInt.asUintN(64, (this.abs(a) << 33n) / this.abs(b));
        const rounded = BigInt.asUintN(64, doubled + 1n) >> 1n;
        return this.wrap((a < 0n) !== (b < 0n) ? -rounded : rounded);
    }
    /** @param {bigint} a @param {bigint} b @returns {bigint} */
    static _mul30(a, b) { return this._i32(this.wrap(a * b) >> 30n); }
    /** @param {bigint} x @param {bigint[]} coefficients @returns {bigint} */
    static _poly30(x, coefficients) {
        let result = coefficients[0];
        for (let i = 1; i < coefficients.length; i++) result = this._i32(this._mul30(result, x) + coefficients[i]);
        return result;
    }
    /** @param {bigint} value @returns {number} */
    static _exponent(value) {
        // Two exactly represented 32-bit limbs reproduce native leading-zero counting.
        const bits = BigInt.asUintN(64, value), high = Number(bits >> 32n);
        return high ? 31 - Math.clz32(high) : -1 - Math.clz32(Number(bits & 0xffffffffn));
    }
    /** @param {bigint} value @param {number} exponent @returns {bigint} */
    static _normalizeExponent(value, exponent) {
        return exponent >= 0 ? value >> BigInt(exponent & 63) : this.wrap(value << BigInt((-exponent) & 63));
    }
    /** @param {bigint} value @param {number} exponent @returns {bigint} */
    static _scaleExponent(value, exponent) {
        return exponent >= 0 ? this.wrap(value << BigInt(exponent & 63)) : value >> BigInt((-exponent) & 63);
    }
    /** @param {bigint} value @returns {bigint} */
    static sqrt(value) {
        if (value === this.POSITIVE_INFINITY) return value;
        if (value === 0n) return 0n;
        if (value < 0n) return this.NAN;
        const exponent = this._exponent(value);
        const x = this._i32((this._normalizeExponent(value, exponent) >> 2n) - 0x40000000n);
        const polynomial = this._poly30(x, [0x19915ccn, -0x6f0ab3cn, 0x1fda0f0bn, 0x40000000n]);
        const factor = (exponent & 1) ? 0x5a827999n : 0x40000000n;
        const mantissa = this._mul30(polynomial, factor) * 4n;
        return this._scaleExponent(mantissa, exponent >> 1);
    }
    /** @param {bigint} radians @returns {bigint} */
    static sin(radians) {
        if (!this.isFinite(radians)) return this.NAN;
        // UnitSinFastest folds the signed 32-bit phase before a Q30 polynomial.
        const phase = this._i32(this.mul(radians, 0x28be60dcn));
        const sign = this._i32(phase * 2n) ^ phase;
        const folded = sign < 0n ? this._i32(0x80000000n - phase) : phase;
        const square = this._mul30(folded, folded);
        const polynomial = this._poly30(square, [0x4a8a318n, -0x29309069n, 0x6487ed51n]);
        return this._mul30(polynomial, folded) * 4n;
    }
    /** @param {bigint} radians @returns {bigint} */
    static cos(radians) {
        if (!this.isFinite(radians)) return this.NAN;
        return this.sin(this.add(radians, this.HALF_PI));
    }
    /** @param {bigint} numerator @param {bigint} denominator @returns {bigint} */
    static _atanRatio(numerator, denominator) {
        const exponent = this._exponent(denominator);
        const x = this._i32((this._normalizeExponent(denominator, exponent) >> 2n) - 0x40000000n);
        const reciprocal = this._poly30(x, [0x9e6d6ecn, -0x22a7f039n, 0x37fd4590n, -0x3f3c2c41n, 0x40000000n]);
        const scaled = this._i32(this._normalizeExponent(numerator, exponent) >> 2n);
        return this._mul30(scaled, reciprocal);
    }
    /** @param {bigint} y @param {bigint} x @returns {bigint} */
    static atan2(y, x) {
        if (y === this.NAN || x === this.NAN) return this.NAN;
        if (!this.isFinite(y)) {
            if (this.isFinite(x)) return y > 0n ? this.HALF_PI : -this.HALF_PI;
            const quarter = this.div(this.HALF_PI, 2n * this.ONE);
            const angle = x > 0n ? quarter : this.mul(quarter, 3n * this.ONE);
            return y > 0n ? angle : this.neg(angle);
        }
        if (!this.isFinite(x)) return x > 0n ? 0n : y < 0n ? -this.PI : this.PI;
        if (x === 0n) return y > 0n ? this.HALF_PI : y < 0n ? -this.HALF_PI : this.NAN;
        const ay = this.abs(y), ax = this.abs(x), sign = (x ^ y) >> 63n;
        const vertical = ax < ay;
        const ratio = this._atanRatio(vertical ? ax : ay, vertical ? ay : ax);
        const angle = this._poly30(ratio, [0x9947f0en, -0x173aced8n, -0x1b578fn, 0x40059e04n, 0n]) * 4n;
        // The native implementation complements signed quadrants, including its LSB.
        if (vertical) return (y > 0n ? this.HALF_PI : -this.HALF_PI) - (angle ^ sign);
        const signed = angle ^ sign;
        if (x > 0n) return signed;
        const quadrantPi = 0x3243f6a89n;
        return signed + (y < 0n ? -quadrantPi : quadrantPi);
    }
    /** @param {bigint} value @returns {bigint} */
    static acos(value) {
        if (value < -this.ONE || value > this.ONE) return this.NAN;
        return this.atan2(this.sqrt(this.mul(this.ONE + value, this.ONE - value)), value);
    }
    /** @param {bigint} value @returns {bigint} */
    static exp(value) {
        // The native wrapper routes every negative special raw value to negative infinity.
        if (!this.isFinite(value)) return value > 0n ? this.POSITIVE_INFINITY : this.NEGATIVE_INFINITY;
        const scaled = this.mul(value, 0x171547652n);
        if (scaled >= 32n * this.ONE) return this.MAX;
        if (scaled <= -32n * this.ONE) return 0n;
        const fraction = (scaled >> 2n) & 0x3fffffffn;
        const polynomial = this._poly30(fraction, [0x50257a9n, 0xe7bd338n, 0x2c81d51fn, 0x40000000n]);
        return this._scaleExponent(polynomial * 4n, Number(scaled >> 32n));
    }
    /** @param {FixedRVOVector2} a @param {FixedRVOVector2} b @returns {bigint} */
    static dot(a, b) { return this.add(this.mul(a.x, b.x), this.mul(a.y, b.y)); }
    /** @param {FixedRVOVector2} vector @returns {bigint} */
    static magnitude(vector) {
        const biggest = this.rawMax(this.abs(vector.x), this.abs(vector.y));
        const limit = 0x800000000000n;
        if (biggest <= limit) return this.sqrt(this.dot(vector, vector));
        const scale = this.div(limit, biggest);
        const scaled = { x: this.mul(vector.x, scale), y: this.mul(vector.y, scale) };
        return this.div(this.sqrt(this.dot(scaled, scaled)), scale);
    }
    /** @param {FixedRVOVector2} vector @returns {{x: bigint, y: bigint, magnitude: bigint}} */
    static normalize(vector) {
        const magnitude = this.magnitude(vector);
        if (magnitude <= this.C1EM5) return { x: 0n, y: 0n, magnitude };
        const reciprocal = this.div(this.ONE, magnitude);
        return { x: this.mul(vector.x, reciprocal), y: this.mul(vector.y, reciprocal), magnitude };
    }
    /** @param {FixedRVOVector2} vector @returns {{x: bigint, y: bigint, magnitude: bigint}} */
    static normalizeInPlace(vector) {
        const magnitude = this.magnitude(vector);
        if (magnitude < this.C1EM5) return { x: 0n, y: 0n, magnitude };
        const reciprocal = this.div(this.ONE, magnitude);
        return { x: this.mul(vector.x, reciprocal), y: this.mul(vector.y, reciprocal), magnitude };
    }
}
