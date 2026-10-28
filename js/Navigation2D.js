// Circle ORCA constraints and linear programs adapted from RVO2 Agent.cc.
// Copyright 2008 University of North Carolina at Chapel Hill. Apache-2.0.
// Local attribution/license: assets/licenses/rvo2-apache.txt.
// This is a stateless floating-point solver, not the sampled native Mechabellum solver.

/** @typedef {{id:string,x:number,y:number,vx:number,vy:number,preferredVX:number,preferredVY:number,radius:number,maxSpeed:number,responsibility?:number,group?:string,innerRadius?:number,groupRadius?:number}} RVOAgent */
/** @typedef {{id:string,x:number,y:number,radius:number}} RVOObstacle */
/** @typedef {{neighborDistance?:number,maxNeighbors?:number,timeHorizon?:number,obstacleTimeHorizon?:number,timeStep?:number}} RVOOptions */
/** @typedef {{x:number,y:number}} RVOVector */
/** @typedef {{point:RVOVector,direction:RVOVector}} RVOLine */

class RVO2D {
    static LICENSE_PATH = 'assets/licenses/rvo2-apache.txt';
    /** Solve one simultaneous velocity sample. The caller owns integration and its clock.
     * @param {readonly RVOAgent[]} agents @param {readonly RVOObstacle[]} [obstacles]
     * @param {RVOOptions} [options] @returns {Array<{id:string,vx:number,vy:number}>} */
    static solve(agents, obstacles = [], options = {}) {
        if (!Array.isArray(agents) || !Array.isArray(obstacles) || !options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('RVO_INPUT_INVALID');
        const allowed = ['neighborDistance', 'maxNeighbors', 'timeHorizon', 'obstacleTimeHorizon', 'timeStep'];
        if (Object.keys(options).some(key => !allowed.includes(key))) throw new TypeError('RVO_OPTIONS_INVALID');
        const config = { neighborDistance: 40, maxNeighbors: 20, timeHorizon: 2, obstacleTimeHorizon: 2, timeStep: 0.2, ...options };
        for (const key of ['neighborDistance', 'timeHorizon', 'obstacleTimeHorizon', 'timeStep']) {
            if (!Number.isFinite(config[key]) || config[key] < 1e-6 || config[key] > 1e9) throw new RangeError('RVO_OPTIONS_INVALID: ' + key);
        }
        if (!Number.isInteger(config.maxNeighbors) || config.maxNeighbors < 0 || config.maxNeighbors > 10000) throw new RangeError('RVO_OPTIONS_INVALID: maxNeighbors');
        if (agents.length > 10000 || obstacles.length > 1024) throw new RangeError('RVO_BUDGET_EXCEEDED');
        const ids = new Set();
        const validate = (entry, moving) => {
            if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 || ids.has(entry.id)) throw new TypeError('RVO_ID_INVALID_OR_DUPLICATE');
            ids.add(entry.id);
            for (const key of ['x', 'y']) if (!Number.isFinite(entry[key]) || Math.abs(entry[key]) > 1e12) throw new RangeError('RVO_POSITION_INVALID');
            if (!Number.isFinite(entry.radius) || entry.radius <= 0 || entry.radius > 1e9) throw new RangeError('RVO_RADIUS_INVALID');
            if (moving) {
                for (const key of ['vx', 'vy', 'preferredVX', 'preferredVY', 'maxSpeed']) {
                    if (!Number.isFinite(entry[key]) || Math.abs(entry[key]) > 1e9) throw new RangeError('RVO_VELOCITY_INVALID');
                }
                if (entry.maxSpeed < 0 || entry.responsibility != null && (!Number.isFinite(entry.responsibility) || entry.responsibility < 0 || entry.responsibility > 1)) throw new RangeError('RVO_RESPONSIBILITY_OR_SPEED_INVALID');
                if (entry.group != null && (typeof entry.group !== 'string' || !entry.group || entry.group.length > 256)) throw new TypeError('RVO_GROUP_INVALID');
                for (const key of ['innerRadius', 'groupRadius']) if (entry[key] != null && (!Number.isFinite(entry[key]) || entry[key] <= 0 || entry[key] > 1e9)) throw new RangeError('RVO_RADIUS_INVALID');
            }
        };
        agents.forEach(entry => validate(entry, true)); obstacles.forEach(entry => validate(entry, false));
        const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        const ordered = agents.slice().sort(compare), walls = obstacles.slice().sort(compare);
        // Keep spatial cell indices safe even for valid large coordinates and tiny queries.
        let largestCoordinate = 0;
        for (const entry of [...ordered, ...walls]) largestCoordinate = Math.max(largestCoordinate, Math.abs(entry.x), Math.abs(entry.y));
        const cellSize = Math.max(config.neighborDistance, largestCoordinate / (Number.MAX_SAFE_INTEGER / 2));
        /** @type {SpatialHash2D<RVOAgent>} */
        const index = new SpatialHash2D(cellSize);
        /** @type {SpatialHash2D<RVOObstacle>} */
        const wallIndex = new SpatialHash2D(cellSize);
        index.rebuild(ordered); wallIndex.rebuild(walls);
        const largestWall = walls.reduce((radius, wall) => Math.max(radius, wall.radius), 0);
        return ordered.map(agent => {
            /** @type {RVOLine[]} */ const lines = [];
            const obstacleRange = Math.max(config.neighborDistance, agent.maxSpeed * config.obstacleTimeHorizon + agent.radius + largestWall);
            for (const wall of wallIndex.queryRadius(agent.x, agent.y, obstacleRange)) {
                lines.push(this._constraint(agent, { ...wall, vx: 0, vy: 0 }, config.obstacleTimeHorizon, config.timeStep, 1));
            }
            const obstacleCount = lines.length;
            const neighbors = index.nearestN(agent.x, agent.y, config.neighborDistance, config.maxNeighbors, other => other.id !== agent.id);
            for (const other of neighbors) {
                const own = agent.responsibility ?? 0.5, theirs = other.responsibility ?? 0.5;
                const share = own + theirs > 0 ? own / (own + theirs) : 0.5;
                // Symmetric circle pair policy. With no groups, ordinary outer radii apply.
                // Across groups, average outer/inner radii keep the reciprocal pair coherent.
                const pairRadius = agent.group && other.group ? (agent.group === other.group ?
                    (agent.groupRadius ?? agent.radius) + (other.groupRadius ?? other.radius) :
                    (agent.radius + (agent.innerRadius ?? agent.radius) + other.radius + (other.innerRadius ?? other.radius)) / 2) : agent.radius + other.radius;
                lines.push(this._constraint(agent, other, config.timeHorizon, config.timeStep, share, pairRadius));
            }
            const optimum = { x: agent.preferredVX, y: agent.preferredVY };
            const result = this._program2(lines, agent.maxSpeed, optimum, false);
            if (result.failed < lines.length) result.velocity = this._program3(lines, obstacleCount, result.failed, agent.maxSpeed, result.velocity);
            return { id: agent.id, vx: result.velocity.x || 0, vy: result.velocity.y || 0 };
        });
    }
    /** @private @param {RVOVector} a @param {RVOVector} b */
    static _det(a, b) { return a.x * b.y - a.y * b.x; }
    /** @private @param {RVOVector} a @param {RVOVector} b */
    static _dot(a, b) { return a.x * b.x + a.y * b.y; }
    /** @private @param {RVOVector} a @param {RVOVector} b */
    static _sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
    /** @private @param {RVOVector} v @param {RVOVector} fallback */
    static _normal(v, fallback) { const length = Math.hypot(v.x, v.y); return length > 1e-12 ? { x: v.x / length, y: v.y / length } : fallback; }
    /** Stable antisymmetric direction for coincident centers and zero relative velocity.
     * @private @param {string} own @param {string} other @returns {RVOVector} */
    static _coincident(own, other) {
        const forward = own < other, pair = forward ? own + '\u0000' + other : other + '\u0000' + own;
        let hash = 2166136261;
        for (let i = 0; i < pair.length; i++) hash = Math.imul(hash ^ pair.charCodeAt(i), 16777619) >>> 0;
        const angle = hash / 4294967296 * Math.PI * 2, sign = forward ? 1 : -1;
        return { x: Math.cos(angle) * sign, y: Math.sin(angle) * sign };
    }
    /** @private @param {RVOAgent} agent @param {RVOObstacle & {vx:number,vy:number}} other
     * @param {number} horizon @param {number} step @param {number} share @param {number} [combinedRadius] @returns {RVOLine} */
    static _constraint(agent, other, horizon, step, share, combinedRadius) {
        const position = { x: other.x - agent.x, y: other.y - agent.y };
        const velocity = { x: agent.vx - other.vx, y: agent.vy - other.vy };
        const distanceSq = this._dot(position, position), radius = combinedRadius ?? agent.radius + other.radius, radiusSq = radius * radius;
        let direction, u;
        if (distanceSq > radiusSq) {
            const inverse = 1 / horizon, w = { x: velocity.x - inverse * position.x, y: velocity.y - inverse * position.y };
            const wSq = this._dot(w, w), dot = this._dot(w, position);
            if (dot < 0 && dot * dot > radiusSq * wSq) {
                const length = Math.sqrt(wSq), normal = this._normal(w, this._coincident(agent.id, other.id));
                direction = { x: normal.y, y: -normal.x };
                u = { x: (radius * inverse - length) * normal.x, y: (radius * inverse - length) * normal.y };
            } else {
                const leg = Math.sqrt(Math.max(0, distanceSq - radiusSq));
                direction = this._det(position, w) > 0 ?
                    { x: (position.x * leg - position.y * radius) / distanceSq, y: (position.x * radius + position.y * leg) / distanceSq } :
                    { x: -(position.x * leg + position.y * radius) / distanceSq, y: -(-position.x * radius + position.y * leg) / distanceSq };
                const projected = this._dot(velocity, direction);
                u = { x: projected * direction.x - velocity.x, y: projected * direction.y - velocity.y };
            }
        } else {
            const inverse = 1 / step, w = { x: velocity.x - inverse * position.x, y: velocity.y - inverse * position.y };
            const length = Math.hypot(w.x, w.y), normal = this._normal(w, this._coincident(agent.id, other.id));
            direction = { x: normal.y, y: -normal.x };
            u = { x: (radius * inverse - length) * normal.x, y: (radius * inverse - length) * normal.y };
        }
        return { direction, point: { x: agent.vx + share * u.x, y: agent.vy + share * u.y } };
    }
    /** @private @param {readonly RVOLine[]} lines @param {number} lineIndex @param {number} radius
     * @param {RVOVector} optimum @param {boolean} directionOnly @returns {RVOVector|null} */
    static _program1(lines, lineIndex, radius, optimum, directionOnly) {
        const line = lines[lineIndex], dot = this._dot(line.point, line.direction);
        const discriminant = dot * dot + radius * radius - this._dot(line.point, line.point);
        if (discriminant < 0) return null;
        const root = Math.sqrt(discriminant); let left = -dot - root, right = -dot + root;
        for (let i = 0; i < lineIndex; i++) {
            const denominator = this._det(line.direction, lines[i].direction);
            const numerator = this._det(lines[i].direction, this._sub(line.point, lines[i].point));
            if (Math.abs(denominator) <= 1e-9) { if (numerator < 0) return null; continue; }
            const t = numerator / denominator;
            if (denominator >= 0) right = Math.min(right, t); else left = Math.max(left, t);
            if (left > right) return null;
        }
        const t = directionOnly ? (this._dot(optimum, line.direction) > 0 ? right : left) :
            Math.max(left, Math.min(right, this._dot(line.direction, this._sub(optimum, line.point))));
        return { x: line.point.x + t * line.direction.x, y: line.point.y + t * line.direction.y };
    }
    /** @private @param {readonly RVOLine[]} lines @param {number} radius @param {RVOVector} optimum
     * @param {boolean} directionOnly @returns {{velocity:RVOVector,failed:number}} */
    static _program2(lines, radius, optimum, directionOnly) {
        const length = Math.hypot(optimum.x, optimum.y), scale = directionOnly ? radius : length > radius ? radius / length : 1;
        let velocity = { x: optimum.x * scale, y: optimum.y * scale };
        for (let i = 0; i < lines.length; i++) {
            if (this._det(lines[i].direction, this._sub(lines[i].point, velocity)) > 1e-9) {
                const candidate = this._program1(lines, i, radius, optimum, directionOnly);
                if (!candidate) return { velocity, failed: i };
                velocity = candidate;
            }
        }
        return { velocity, failed: lines.length };
    }
    /** @private @param {readonly RVOLine[]} lines @param {number} obstacleCount @param {number} begin
     * @param {number} radius @param {RVOVector} initial @returns {RVOVector} */
    static _program3(lines, obstacleCount, begin, radius, initial) {
        let distance = 0, velocity = initial;
        for (let i = begin; i < lines.length; i++) {
            if (this._det(lines[i].direction, this._sub(lines[i].point, velocity)) <= distance + 1e-9) continue;
            const projected = lines.slice(0, obstacleCount);
            for (let j = obstacleCount; j < i; j++) {
                const determinant = this._det(lines[i].direction, lines[j].direction); let point;
                if (Math.abs(determinant) <= 1e-9) {
                    if (this._dot(lines[i].direction, lines[j].direction) > 0) continue;
                    point = { x: (lines[i].point.x + lines[j].point.x) / 2, y: (lines[i].point.y + lines[j].point.y) / 2 };
                } else {
                    const t = this._det(lines[j].direction, this._sub(lines[i].point, lines[j].point)) / determinant;
                    point = { x: lines[i].point.x + t * lines[i].direction.x, y: lines[i].point.y + t * lines[i].direction.y };
                }
                const direction = this._normal(this._sub(lines[j].direction, lines[i].direction), { x: 1, y: 0 });
                projected.push({ point, direction });
            }
            const result = this._program2(projected, radius, { x: -lines[i].direction.y, y: lines[i].direction.x }, true);
            if (result.failed === projected.length) velocity = result.velocity;
            distance = this._det(lines[i].direction, this._sub(lines[i].point, velocity));
        }
        return velocity;
    }
}
