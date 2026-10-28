// Fixed-point sampled-gradient circle avoidance ported from the pinned native
// RVOAgentFixed/Agent/VO kernels. Evidence and qualified spatial adaptation:
// docs/GRADIENT_NAVIGATION.md and eval/artifacts/native-rvo-2026-10-05.
// The caller owns simultaneous snapshots, sampling cadence, and finite movement.

/** @typedef {{x:bigint,y:bigint}} GradientRVOVector */
/** @typedef {{id:string,x:number,y:number,targetX:number,targetY:number,desiredSpeed:number,maxSpeed:number,vx:number,vy:number,radius:number,innerRadius?:number,teamRadius?:number,priority?:number,stopPriorityScale?:number,stopped?:boolean,group?:string,team?:number,size?:number,colliderPriority?:number,mainLayer?:number,layer?:number,collidesWith?:number,elevation?:number,height?:number,ignoreSameGroup?:boolean,locked?:boolean,manuallyControlled?:boolean,calculatedTargetX?:number,calculatedTargetY?:number,calculatedSpeed?:number}} GradientRVOAgent */
/** @typedef {{timeHorizon?:number,timeStep?:number,maxNeighbors?:number,symmetryBreakingBias?:number}} GradientRVOOptions */
/** @typedef {{id:string,vx:number,vy:number,targetX:number,targetY:number,speed:number}} GradientRVOSolution */

class GradientRVO2D {
    /** Solve a simultaneous sample in meters. Results preserve the input order.
     * The candidate endpoint is independent of the capped movement speed.
     * @param {readonly GradientRVOAgent[]} agents
     * @param {GradientRVOOptions} [options]
     * @returns {GradientRVOSolution[]} */
    static solve(agents, options = {}) {
        const parsed = this._parse(agents, options, false);
        if (typeof GradientRVOWasm === 'undefined') throw new Error('GRADIENT_RVO_BACKEND_UNAVAILABLE');
        return GradientRVOWasm.solve(parsed.entries, parsed.timeHorizon, parsed.timeStep, parsed.bias, parsed.maxNeighbors);
    }

    /** Explicit BigInt reference path for verification, not an automatic fallback.
     * @param {readonly GradientRVOAgent[]} agents
     * @param {GradientRVOOptions} [options]
     * @returns {GradientRVOSolution[]} */
    static solveReference(agents, options = {}) {
        const parsed = this._parse(agents, options);
        return this._solveReference(parsed);
    }

    static _parse(agents, options, referenceGeometry = true) {
        if (!Array.isArray(agents) || !options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('GRADIENT_RVO_INPUT_INVALID');
        if (agents.length > 2048) throw new RangeError('GRADIENT_RVO_BUDGET_EXCEEDED');
        const allowedOptions = ['timeHorizon', 'timeStep', 'maxNeighbors', 'symmetryBreakingBias'];
        if (Object.keys(options).some(key => !allowedOptions.includes(key))) throw new TypeError('GRADIENT_RVO_OPTIONS_INVALID');
        const config = { timeHorizon: 12, timeStep: 0.2, maxNeighbors: 20, symmetryBreakingBias: 0.1, ...options };
        for (const key of ['timeHorizon', 'timeStep']) {
            if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > 1000000) throw new RangeError('GRADIENT_RVO_OPTIONS_INVALID: ' + key);
        }
        if (!Number.isInteger(config.maxNeighbors) || config.maxNeighbors < 0 || config.maxNeighbors > 256) throw new RangeError('GRADIENT_RVO_OPTIONS_INVALID: maxNeighbors');
        if (!Number.isFinite(config.symmetryBreakingBias) || config.symmetryBreakingBias < 0 || config.symmetryBreakingBias > Math.PI) throw new RangeError('GRADIENT_RVO_OPTIONS_INVALID: symmetryBreakingBias');
        const Q = FixedRVOQ32;
        const ids = new Set();
        const finite = (value, field, nonnegative = false) => {
            if (!Number.isFinite(value) || Math.abs(value) > 1000000 || nonnegative && value < 0) throw new RangeError('GRADIENT_RVO_AGENT_INVALID: ' + field);
            return Q.fromNumber(value);
        };
        // Validate every entry before calculation. No input or nested object is mutated.
        const entries = agents.map(agent => {
            if (!agent || typeof agent !== 'object' || Array.isArray(agent) || typeof agent.id !== 'string' || !agent.id || agent.id.length > 256 || ids.has(agent.id)) throw new TypeError('GRADIENT_RVO_ID_INVALID_OR_DUPLICATE');
            ids.add(agent.id);
            const group = agent.group ?? 'common';
            if (typeof group !== 'string' || !group || group.length > 256) throw new TypeError('GRADIENT_RVO_GROUP_INVALID');
            for (const key of ['team', 'size', 'mainLayer']) {
                if (agent[key] != null && (!Number.isInteger(agent[key]) || agent[key] < 0 || agent[key] > (key === 'mainLayer' ? 2 : 2147483647))) throw new RangeError('GRADIENT_RVO_AGENT_INVALID: ' + key);
            }
            if (agent.colliderPriority != null && (!Number.isInteger(agent.colliderPriority) || agent.colliderPriority < 1 || agent.colliderPriority > 10)) throw new RangeError('GRADIENT_RVO_AGENT_INVALID: colliderPriority');
            const colliderPriority = agent.colliderPriority ?? 3;
            const colliderBit = 2 * (colliderPriority - 1);
            const defaultLayer = 2 ** colliderBit;
            const defaultMask = (0x7fffffff - (2 ** colliderBit - 1)) >>> 0;
            for (const key of ['layer', 'collidesWith']) {
                if (agent[key] != null && (!Number.isInteger(agent[key]) || agent[key] < 0 || agent[key] > 0xffffffff)) throw new RangeError('GRADIENT_RVO_AGENT_INVALID: ' + key);
            }
            for (const key of ['locked', 'manuallyControlled', 'ignoreSameGroup', 'stopped']) {
                if (agent[key] != null && typeof agent[key] !== 'boolean') throw new TypeError('GRADIENT_RVO_AGENT_INVALID: ' + key);
            }
            const position = { x: finite(agent.x, 'x'), y: finite(agent.y, 'y') };
            const target = { x: finite(agent.targetX, 'targetX'), y: finite(agent.targetY, 'targetY') };
            const current = { x: finite(agent.vx, 'vx'), y: finite(agent.vy, 'vy') };
            const radius = finite(agent.radius, 'radius', true);
            if (radius === Q.ZERO) throw new RangeError('GRADIENT_RVO_AGENT_INVALID: radius');
            const innerRadius = finite(agent.innerRadius ?? agent.radius, 'innerRadius', true);
            const teamRadius = finite(agent.teamRadius ?? agent.radius, 'teamRadius', true);
            const maxSpeed = finite(agent.maxSpeed, 'maxSpeed', true);
            const desiredSpeed = Q.min(finite(agent.desiredSpeed, 'desiredSpeed', true), maxSpeed);
            const basePriority = finite(agent.priority ?? 0.5, 'priority', true);
            const stopPriorityScale = finite(agent.stopPriorityScale ?? 0.05, 'stopPriorityScale', true);
            // RVOControllerFixed applies this branch while buffering properties.
            // An explicit stopped flag represents StopMove independently of speed.
            const stopped = agent.stopped ?? desiredSpeed === Q.ZERO;
            const priority = stopped && Q.gt(stopPriorityScale, Q.ONE) && Q.lt(basePriority, Q.C01) ? Q.mul(basePriority, stopPriorityScale) : basePriority;
            const manuallyControlled = agent.manuallyControlled ?? false;
            const calculatedSpeed = finite(agent.calculatedSpeed ?? (manuallyControlled ? undefined : 0), 'calculatedSpeed', true);
            let retained = null;
            if (manuallyControlled) {
                retained = {
                    target: { x: finite(agent.calculatedTargetX, 'calculatedTargetX'), y: finite(agent.calculatedTargetY, 'calculatedTargetY') },
                    speed: calculatedSpeed,
                };
            }
            const locked = !manuallyControlled && (agent.locked ?? false);
            // The C solver computes its own desired geometry; the reference
            // parser remains complete for solveReference and direct callers.
            const relativeTarget = referenceGeometry ? this._sub(target, position) : null;
            const desired = referenceGeometry ? (locked ? this._zero() : this._scale(this._normalize(relativeTarget), desiredSpeed)) : null;
            return {
                id: agent.id, position, target, current: locked ? this._zero() : current, relativeTarget, desired, desiredSpeed, maxSpeed,
                radius, innerRadius, teamRadius, priority, stopPriorityScale, group, team: agent.team ?? 0, size: agent.size ?? 0,
                mainLayer: agent.mainLayer ?? 1, layer: agent.layer ?? defaultLayer, collidesWith: agent.collidesWith ?? defaultMask,
                elevation: finite(agent.elevation ?? 0, 'elevation'), height: finite(agent.height ?? 5, 'height', true),
                ignoreSameGroup: agent.ignoreSameGroup ?? false, locked, manuallyControlled, calculatedSpeed, retained,
            };
        });
        const timeHorizon = Q.fromNumber(config.timeHorizon);
        const inverseHorizon = referenceGeometry ? Q.div(Q.ONE, timeHorizon) : null;
        const timeStep = Q.fromNumber(config.timeStep);
        const inverseDeltaTime = referenceGeometry ? Q.div(Q.ONE, timeStep) : null;
        const bias = Q.fromNumber(config.symmetryBreakingBias);
        return { entries, timeHorizon, timeStep, inverseHorizon, inverseDeltaTime, bias, maxNeighbors: config.maxNeighbors };
    }

    static _solveReference(parsed) {
        const { entries, timeHorizon, inverseHorizon, inverseDeltaTime, bias, maxNeighbors } = parsed;
        const Q = FixedRVOQ32;
        const tree = this._buildTree(entries);
        return entries.map(entry => {
            if (entry.manuallyControlled) return this._result(entry, entry.retained.target, entry.retained.speed);
            if (entry.locked) return this._result(entry, entry.position, Q.ZERO);
            const neighbors = this._neighbors(entry, tree, timeHorizon, maxNeighbors);
            const vos = [];
            for (const other of neighbors) {
                if (Q.lt(Q.sub(Q.min(Q.add(entry.elevation, entry.height), Q.add(other.elevation, other.height)), Q.max(entry.elevation, other.elevation)), Q.ZERO)) continue;
                const center = this._sub(other.position, entry.position);
                if (entry.group !== other.group) {
                    // The native opponent inverse horizon is the fixed value 100.
                    vos.push(this._circleVO(center, this._zero(), Q.add(entry.radius, other.innerRadius), 100n * Q.ONE, inverseDeltaTime));
                    continue;
                }
                if (other.ignoreSameGroup) continue;
                const radius = entry.team > 0 && entry.team === other.team ? Q.add(entry.teamRadius, other.teamRadius)
                    : entry.size >= other.size ? Q.add(entry.radius, other.radius) : Q.add(entry.innerRadius, other.innerRadius);
                const responsibility = other.locked || other.manuallyControlled ? Q.ONE
                    : Q.gt(other.priority, Q.EPS) || Q.gt(entry.priority, Q.EPS) ? Q.div(other.priority, Q.add(entry.priority, other.priority)) : Q.ONE / 2n;
                const otherVelocity = this._lerp(other.current, other.desired, Q.sub(Q.mul(2n * Q.ONE, responsibility), Q.ONE));
                const offset = this._lerp(entry.current, otherVelocity, responsibility);
                vos.push(this._circleVO(center, offset, radius, inverseHorizon, inverseDeltaTime));
            }
            const biased = this._biasDesired(entry.desired, entry.relativeTarget, vos, bias);
            if (!biased.positive) return this._result(entry, this._add(entry.position, biased.relativeTarget), entry.desiredSpeed);
            // CalculateVelocity passes sync_desiredVelocity by reference to
            // BiasDesiredVelocity; EvaluateGradient reads that mutated field.
            // Neighbor VOs still read the separate unmodified desiredVelocity.
            const traceEntry = { ...entry, desired: biased.desired };
            const candidate = this._descent(traceEntry, vos, entry.current, biased.desired);
            return this._result(entry, this._add(entry.position, candidate), Q.min(this._magnitude(candidate), entry.maxSpeed));
        });
    }

    /** Native quadtree insertion/list order and adaptive node-speed pruning. */
    static _buildTree(entries) {
        const Q = FixedRVOQ32;
        const nodes = [{ child: 0, head: -1, count: 0, maxSpeed: Q.ZERO }];
        const next = entries.map(() => -1);
        let minX = entries[0]?.position.x ?? Q.ZERO, minY = entries[0]?.position.y ?? Q.ZERO;
        let maxX = minX, maxY = minY;
        for (const entry of entries) {
            minX = Q.min(minX, entry.position.x); minY = Q.min(minY, entry.position.y);
            maxX = Q.max(maxX, entry.position.x); maxY = Q.max(maxY, entry.position.y);
        }
        const bounds = { x: minX, y: minY, width: Q.sub(maxX, minX), height: Q.sub(maxY, minY) };
        for (let agentIndex = 0; agentIndex < entries.length; agentIndex++) {
            let nodeIndex = 0, depth = 1, rect = bounds;
            while (true) {
                const node = nodes[nodeIndex];
                const center = this._rectCenter(rect);
                if (node.child === nodeIndex && node.count >= 15 && depth <= 10) {
                    node.child = nodes.length;
                    for (let child = 0; child < 4; child++) nodes.push({ child: nodes.length, head: -1, count: 0, maxSpeed: Q.ZERO });
                    // Distribution pushes existing list heads, reversing each child
                    // subset; the native child insertion counters stay zero.
                    while (node.head !== -1) {
                        const index = node.head;
                        node.head = next[index];
                        const quadrant = (Q.gt(entries[index].position.x, center.x) ? 2 : 0) + (Q.gt(entries[index].position.y, center.y) ? 1 : 0);
                        const child = nodes[node.child + quadrant];
                        next[index] = child.head; child.head = index;
                    }
                    node.count = 0;
                }
                if (node.child === nodeIndex) {
                    next[agentIndex] = node.head; node.head = agentIndex;
                    node.count = (node.count + 1) & 255;
                    break;
                }
                const quadrant = (Q.gt(entries[agentIndex].position.x, center.x) ? 2 : 0) + (Q.gt(entries[agentIndex].position.y, center.y) ? 1 : 0);
                rect = this._rectChild(rect, center, quadrant);
                nodeIndex = node.child + quadrant;
                depth++;
            }
        }
        const calculateSpeed = index => {
            const node = nodes[index];
            if (node.child === index) {
                for (let agent = node.head; agent !== -1; agent = next[agent]) node.maxSpeed = Q.max(node.maxSpeed, entries[agent].calculatedSpeed);
            } else {
                for (let child = 0; child < 4; child++) node.maxSpeed = Q.max(node.maxSpeed, calculateSpeed(node.child + child));
            }
            return node.maxSpeed;
        };
        calculateSpeed(0);
        return { entries, nodes, next, bounds };
    }

    static _rectCenter(rect) {
        const Q = FixedRVOQ32;
        return { x: Q.add(rect.x, Q.mul(rect.width, Q.ONE / 2n)), y: Q.add(rect.y, Q.mul(rect.height, Q.ONE / 2n)) };
    }

    static _rectChild(rect, center, quadrant) {
        const Q = FixedRVOQ32;
        const x = quadrant & 2 ? center.x : rect.x, y = quadrant & 1 ? center.y : rect.y;
        const maxX = quadrant & 2 ? Q.add(rect.x, rect.width) : center.x;
        const maxY = quadrant & 1 ? Q.add(rect.y, rect.height) : center.y;
        return { x, y, width: Q.sub(maxX, x), height: Q.sub(maxY, y) };
    }

    static _neighbors(entry, tree, horizon, count) {
        if (count === 0) return [];
        const Q = FixedRVOQ32;
        const selected = [];
        let maxRadius = Q.POSITIVE_INFINITY;
        const insert = (other, rangeSquared) => {
            if (other === entry || other.mainLayer !== entry.mainLayer || !(entry.collidesWith & other.layer)) return rangeSquared;
            const distanceSquared = this._sqrMagnitude(this._sub(other.position, entry.position));
            if (!Q.lt(distanceSquared, rangeSquared)) return rangeSquared;
            if (selected.length < count) selected.push({ other: null, distanceSquared: Q.POSITIVE_INFINITY });
            let slot = selected.length - 1;
            if (Q.lt(distanceSquared, selected[slot].distanceSquared)) {
                while (slot > 0 && Q.lt(distanceSquared, selected[slot - 1].distanceSquared)) {
                    selected[slot] = selected[slot - 1]; slot--;
                }
                selected[slot] = { other, distanceSquared };
            }
            return selected.length === count ? selected[count - 1].distanceSquared : rangeSquared;
        };
        const query = (index, rect) => {
            const node = tree.nodes[index];
            let radius = Q.min(Q.add(Q.max(Q.mul(Q.add(entry.maxSpeed, node.maxSpeed), horizon), entry.radius), entry.radius), maxRadius);
            if (node.child === index) {
                // The leaf keeps its local radius for every insertion; only the
                // query's shared maximum shrinks for later recursive branches.
                const rangeSquared = Q.mul(radius, radius);
                for (let agent = node.head; agent !== -1; agent = tree.next[agent]) {
                    const returnedRange = insert(tree.entries[agent], rangeSquared);
                    if (Q.lt(returnedRange, Q.mul(maxRadius, maxRadius))) maxRadius = Q.sqrt(returnedRange);
                }
                return;
            }
            const center = this._rectCenter(rect);
            const visit = quadrant => {
                query(node.child + quadrant, this._rectChild(rect, center, quadrant));
                radius = Q.min(radius, maxRadius);
            };
            if (Q.lt(Q.sub(entry.position.x, radius), center.x)) {
                if (Q.lt(Q.sub(entry.position.y, radius), center.y)) visit(0);
                if (Q.gt(Q.add(entry.position.y, radius), center.y)) visit(1);
            }
            if (Q.gt(Q.add(entry.position.x, radius), center.x)) {
                if (Q.lt(Q.sub(entry.position.y, radius), center.y)) visit(2);
                if (Q.gt(Q.add(entry.position.y, radius), center.y)) visit(3);
            }
        };
        query(0, tree.bounds);
        return selected.map(item => item.other);
    }

    static _circleVO(center, offset, radius, inverseHorizon, inverseDeltaTime) {
        const Q = FixedRVOQ32;
        const ratio = Q.div(this._sqrMagnitude(center), Q.mul(radius, radius));
        const weightFactor = Q.add(Q.ONE, Q.mul(4n * Q.ONE, Q.exp(Q.neg(Q.mul(ratio, ratio)))));
        const circleCenter = this._add(this._scale(center, inverseHorizon), offset);
        const distance = this._magnitude(center);
        if (Q.lt(distance, radius)) {
            const line = this._scale(this._scale(this._scale(this._normalize(center), Q.sub(Q.sub(distance, radius), Q.C1EM3)), Q.C03), inverseDeltaTime);
            return { line1: this._add(line, offset), line2: this._zero(), dir1: this._normalize(this._cw(line)), dir2: this._zero(), cutoffLine: this._zero(), cutoffDir: this._zero(), circleCenter, radius: Q.ZERO, colliding: true, weightFactor };
        }
        const angle = Q.atan2(Q.neg(center.y), Q.neg(center.x));
        const halfAngle = Q.abs(Q.acos(Q.div(radius, distance)));
        const scaledCenter = this._scale(center, inverseHorizon);
        const scaledRadius = Q.mul(radius, inverseHorizon);
        const translatedCenter = this._add(scaledCenter, offset);
        const cutoff = this._scale(this._normalize(scaledCenter), Q.add(Q.sub(this._magnitude(scaledCenter), scaledRadius), Q.C1EM3));
        const a1 = Q.add(angle, halfAngle), a2 = Q.sub(angle, halfAngle);
        const radial1 = { x: Q.cos(a1), y: Q.sin(a1) };
        const radial2 = { x: Q.cos(a2), y: Q.sin(a2) };
        return {
            line1: this._add(this._scale(radial1, scaledRadius), translatedCenter), line2: this._add(this._scale(radial2, scaledRadius), translatedCenter),
            dir1: this._cw(radial1), dir2: this._cw(radial2), cutoffLine: this._add(cutoff, offset), cutoffDir: this._normalize(this._ccw(cutoff)),
            circleCenter, radius: scaledRadius, colliding: false, weightFactor,
        };
    }

    static _gradient(vo, point) {
        const Q = FixedRVOQ32;
        if (vo.colliding) {
            const distance = this._signedDistance(vo.line1, vo.dir1, point);
            return Q.ge(distance, Q.ZERO) ? { vector: this._ccw(vo.dir1), weight: distance } : { vector: this._zero(), weight: Q.ZERO };
        }
        const cutoff = this._signedDistance(vo.cutoffLine, vo.cutoffDir, point);
        if (Q.le(cutoff, Q.ZERO)) return { vector: this._zero(), weight: Q.ZERO };
        const d1 = this._signedDistance(vo.line1, vo.dir1, point);
        const d2 = this._signedDistance(vo.line2, vo.dir2, point);
        if (!Q.ge(d1, Q.ZERO) || !Q.ge(d2, Q.ZERO)) return { vector: this._zero(), weight: Q.ZERO };
        if (Q.gt(this._dot(this._sub(point, vo.line1), vo.dir1), Q.ZERO) && Q.lt(this._dot(this._sub(point, vo.line2), vo.dir2), Q.ZERO)) {
            const delta = this._sub(point, vo.circleCenter);
            const magnitude = this._magnitude(delta);
            const normalized = Q.normalize(delta);
            return { vector: { x: normalized.x, y: normalized.y }, weight: Q.sub(vo.radius, magnitude) };
        }
        return Q.lt(d1, d2) ? { vector: this._ccw(vo.dir1), weight: d1 } : { vector: this._ccw(vo.dir2), weight: d2 };
    }

    static _scaledGradient(vo, point) {
        const Q = FixedRVOQ32;
        const gradient = this._gradient(vo, point);
        if (!Q.gt(gradient.weight, Q.ZERO)) return gradient;
        const factor = Q.mul(2n * Q.ONE, vo.weightFactor);
        return { vector: this._scale(gradient.vector, factor), weight: Q.add(Q.mul(gradient.weight, factor), Q.ONE) };
    }

    static _biasDesired(initialDesired, initialTarget, vos, bias) {
        const Q = FixedRVOQ32;
        let rawWeight = Q.ZERO;
        for (const vo of vos) rawWeight = Q.max(rawWeight, this._gradient(vo, initialDesired).weight);
        const positive = Q.gt(rawWeight, Q.ZERO);
        const magnitude = this._magnitude(initialDesired);
        if (Q.lt(magnitude, Q.C1EM3)) return { desired: initialDesired, relativeTarget: initialTarget, positive };
        const amount = Q.min(bias, Q.div(rawWeight, magnitude));
        return {
            desired: this._add(initialDesired, this._scale(this._cw(initialDesired), amount)),
            relativeTarget: this._add(initialTarget, this._scale(this._cw(initialTarget), amount)),
            positive,
        };
    }

    static _evaluate(entry, vos, point) {
        const Q = FixedRVOQ32;
        let gradient = this._zero(), score = Q.ZERO;
        for (const vo of vos) {
            const candidate = this._scaledGradient(vo, point);
            if (Q.gt(candidate.weight, score)) { gradient = candidate.vector; score = candidate.weight; }
        }
        // The caller supplies its current sync velocity, after any bias mutation.
        const difference = this._sub(entry.desired, point);
        const differenceMagnitude = this._magnitude(difference);
        if (Q.gt(differenceMagnitude, Q.C1EM4)) {
            gradient = this._add(gradient, this._scale(difference, Q.div(Q.C01, differenceMagnitude)));
            score = Q.add(score, Q.mul(differenceMagnitude, Q.C01));
        }
        const speedSquared = this._sqrMagnitude(point);
        if (Q.gt(speedSquared, Q.mul(entry.desiredSpeed, entry.desiredSpeed))) {
            const speed = Q.sqrt(speedSquared);
            const direction = this._divide(point, speed);
            if (Q.gt(speed, entry.maxSpeed)) {
                score = Q.add(score, Q.mul(3n * Q.ONE, Q.sub(speed, entry.maxSpeed)));
                gradient = this._sub(gradient, this._scale(direction, 3n * Q.ONE));
            }
            const factor = Q.mul(2n * Q.ONE, Q.C01);
            score = Q.add(score, Q.mul(factor, Q.sub(speed, entry.desiredSpeed)));
            gradient = this._sub(gradient, this._scale(direction, factor));
        }
        return { vector: gradient, score };
    }

    static _descent(entry, vos, firstSeed, secondSeed) {
        const first = this._trace(entry, vos, firstSeed);
        const second = this._trace(entry, vos, secondSeed);
        return FixedRVOQ32.lt(first.score, second.score) ? first.point : second.point;
    }

    static _trace(entry, vos, seed) {
        const Q = FixedRVOQ32;
        const baseStep = Q.max(entry.radius, Q.mul(entry.desiredSpeed, Q.C02));
        let point = seed, bestPoint = seed, bestScore = Q.POSITIVE_INFINITY;
        for (let i = 0; i < 50; i++) {
            const remaining = Q.sub(Q.ONE, Q.div(BigInt(i) * Q.ONE, 50n * Q.ONE));
            const step = Q.mul(Q.mul(remaining, remaining), baseStep);
            const evaluation = this._evaluate(entry, vos, point);
            if (Q.lt(evaluation.score, bestScore)) { bestScore = evaluation.score; bestPoint = point; }
            point = this._add(point, this._scale(this._normalize(evaluation.vector), step));
        }
        return { point: bestPoint, score: bestScore };
    }

    static _result(entry, target, speed) {
        const Q = FixedRVOQ32;
        const velocity = this._scale(this._normalize(this._sub(target, entry.position)), speed);
        const values = { id: entry.id, vx: Q.toNumber(velocity.x), vy: Q.toNumber(velocity.y), targetX: Q.toNumber(target.x), targetY: Q.toNumber(target.y), speed: Q.toNumber(speed) };
        if (!Object.values(values).slice(1).every(Number.isFinite)) throw new RangeError('GRADIENT_RVO_RESULT_INVALID');
        return values;
    }

    static _zero() { return { x: 0n, y: 0n }; }
    static _add(a, b) { const Q = FixedRVOQ32; return { x: Q.add(a.x, b.x), y: Q.add(a.y, b.y) }; }
    static _sub(a, b) { const Q = FixedRVOQ32; return { x: Q.sub(a.x, b.x), y: Q.sub(a.y, b.y) }; }
    static _scale(a, factor) { const Q = FixedRVOQ32; return { x: Q.mul(a.x, factor), y: Q.mul(a.y, factor) }; }
    static _divide(a, divisor) { return this._scale(a, FixedRVOQ32.div(FixedRVOQ32.ONE, divisor)); }
    static _dot(a, b) { const Q = FixedRVOQ32; return Q.add(Q.mul(a.x, b.x), Q.mul(a.y, b.y)); }
    static _sqrMagnitude(a) { return this._dot(a, a); }
    static _magnitude(a) { return FixedRVOQ32.magnitude(a); }
    static _normalize(a) {
        const normalized = FixedRVOQ32.normalizeInPlace(a);
        return { x: normalized.x, y: normalized.y };
    }
    static _cw(a) { return { x: a.y, y: FixedRVOQ32.neg(a.x) }; }
    static _ccw(a) { return { x: FixedRVOQ32.neg(a.y), y: a.x }; }
    static _lerp(a, b, t) {
        const Q = FixedRVOQ32;
        t = Q.clamp01(t);
        return this._add(this._scale(a, Q.sub(Q.ONE, t)), this._scale(b, t));
    }
    static _signedDistance(line, direction, point) {
        const Q = FixedRVOQ32;
        return Q.sub(Q.mul(Q.sub(point.x, line.x), direction.y), Q.mul(Q.sub(point.y, line.y), direction.x));
    }
}
