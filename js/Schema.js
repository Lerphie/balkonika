// Schema.js — shared data contracts and a non-executing parser for editable documents.
// This classic script is also loaded by tools/schema.mjs in an isolated Node context.
/** @satisfies {Record<string, any>} */
const ArcSchema = {
    version: 1,
    objectKinds: ['actor', 'prop'],
    animAxes: ['x', '-x', 'y', '-y', 'z', '-z'],
    kinds: ['text', 'panel', 'bar', 'button'],
    anchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
    uiTypes: {
        x: 'px', y: 'px', w: 'size', h: 'size', radius: 'size', fontSize: 'size', value: 'unit', alpha: 'unit', fillAlpha: 'unit',
        color: 'color', fill: 'color', border: 'color', shadow: 'color', text: 'text', visible: 'flag', parent: 'id', stretch: 'stretch',
        enabled: 'boolean', ariaLabel: 'text', interactive: 'boolean', modal: 'boolean', safeArea: 'boolean'
    },
    uiDefaults: {
        text: { parent: '', anchor: 'top-left', x: 20, y: 20, text: 'Text', fontSize: 24, color: '#ffffff', shadow: '#000000', alpha: 1, visible: 1, ariaLabel: '', safeArea: true },
        panel: { parent: '', anchor: 'top-left', x: 20, y: 20, w: 240, h: 80, stretch: '', fill: '#10202c', fillAlpha: 1, border: '', radius: 10, alpha: 0.7, visible: 1, interactive: false, modal: false, ariaLabel: '', safeArea: true },
        bar: { parent: '', anchor: 'top-left', x: 20, y: 20, w: 240, h: 18, stretch: '', value: 0.6, color: '#5ad05a', fill: '#10202c', fillAlpha: 1, border: '#ffffff', radius: 9, alpha: 1, visible: 1, ariaLabel: '', safeArea: true },
        button: { parent: '', anchor: 'bottom-center', x: 0, y: 40, w: 180, h: 48, stretch: '', text: 'Button', fontSize: 20, color: '#ffffff', fill: '#2a6fb0', fillAlpha: 1, border: '', radius: 10, alpha: 1, visible: 1, enabled: true, ariaLabel: '', safeArea: true }
    },
    get uiFields() {
        return Object.fromEntries(Object.entries(this.uiDefaults).map(([kind, defaults]) => [kind, Object.keys(defaults).filter(k => k !== 'anchor')]));
    },
    id(value) { return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(value); },
    assetPath(value) {
        return typeof value === 'string' && /^assets\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').some(p => p === '..' || p === '.' || !p);
    },
    json(value, depth = 0) {
        if (depth > 12) return false;
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (Array.isArray(value)) return value.length <= 10000 && value.every(v => this.json(v, depth + 1));
        return !!value && typeof value === 'object' && Object.keys(value).length <= 1000 && Object.entries(value).every(([k, v]) => !['__proto__', 'prototype', 'constructor'].includes(k) && this.json(v, depth + 1));
    },
    diagnostic(code, file, index, field, message, hint) { return { severity: 'error', code, file, index, field, message, hint }; },
    // Shared by object documents, editor controls and the runtime body factory.
    // Omitted fields use enabled/dynamic/box/1/0.5/0.1 defaults; zero and false stay explicit.
    validPhysics(definition) {
        const p = definition;
        if (!p || typeof p !== 'object' || Array.isArray(p) || !this.json(p) || Object.keys(p).some(key => !['enabled', 'motion', 'shape', 'mass', 'friction', 'restitution', 'size', 'radius', 'height', 'center'].includes(key))) return false;
        const has = key => Object.hasOwn(p, key), motion = has('motion') ? p.motion : 'dynamic', shape = has('shape') ? p.shape : 'box';
        if (!['static', 'dynamic', 'kinematic'].includes(motion) || !['box', 'sphere', 'capsule'].includes(shape)) return false;
        if (has('enabled') && typeof p.enabled !== 'boolean') return false;
        if (has('mass') && (!Number.isFinite(p.mass) || p.mass < 0 || motion === 'dynamic' && p.mass === 0)) return false;
        if (has('friction') && (!Number.isFinite(p.friction) || p.friction < 0)) return false;
        if (has('restitution') && (!Number.isFinite(p.restitution) || p.restitution < 0 || p.restitution > 1)) return false;
        const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
        if (has('center') && !vector(p.center)) return false;
        if (has('size') && (shape !== 'box' || !vector(p.size) || p.size.some(value => value <= 0))) return false;
        if (has('radius') && (!['sphere', 'capsule'].includes(shape) || !Number.isFinite(p.radius) || p.radius <= 0)) return false;
        if (has('height') && (shape !== 'capsule' || !Number.isFinite(p.height) || p.height <= 0)) return false;
        return !(shape === 'capsule' && has('height') && has('radius') && p.height < 2 * p.radius);
    },
    validPrefab(prefab) {
        if (!prefab || Array.isArray(prefab) || typeof prefab !== 'object' || !this.json(prefab) || Object.keys(prefab).some(k => !['parts', 'render'].includes(k))) return false;
        if (!Array.isArray(prefab.parts) || !prefab.parts.length || prefab.parts.length > 128) return false;
        const ids = new Set(), vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
        for (const part of prefab.parts) {
            if (!part || Object.keys(part).some(k => !['id', 'shape', 'size', 'position', 'rotation', 'color'].includes(k)) || !this.id(part.id) || ids.has(part.id)) return false;
            ids.add(part.id);
            if (!['box', 'sphere', 'cylinder', 'ground'].includes(part.shape) || !vector(part.size) || part.size.some(n => n <= 0)) return false;
            if (part.position != null && !vector(part.position) || part.rotation != null && !vector(part.rotation)) return false;
            if (part.color != null && (typeof part.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(part.color))) return false;
        }
        return prefab.render == null || typeof prefab.render === 'object' && !Array.isArray(prefab.render) && Object.entries(prefab.render).every(([k, v]) => ['castShadow', 'receiveShadows', 'ink', 'outline'].includes(k) && typeof v === 'boolean');
    },
    validateObjects(objects, { requireIds = false } = {}) {
        const file = 'js/Objects.js', out = [], ids = new Set();
        const fail = (i, field, message) => out.push(this.diagnostic('OBJECT_INVALID', file, i, field, message, 'Correct the object data before saving.'));
        if (!Array.isArray(objects)) return [this.diagnostic('OBJECTS_NOT_ARRAY', file, -1, '', 'Expected an array.', 'Use LOCATION_OBJECTS = [...].')];
        objects.forEach((o, i) => {
            if (!o || typeof o !== 'object') { fail(i, '', 'Expected an object.'); return; }
            if (requireIds || o.id != null) {
                if (!this.id(o.id) || ids.has(o.id)) fail(i, 'id', 'Object ID must be valid and unique.');
                ids.add(o.id);
            }
            if (typeof o.name !== 'string') fail(i, 'name', 'Expected a display name.');
            if (o.prefab != null) {
                if (o.model != null || !this.validPrefab(o.prefab)) fail(i, 'prefab', 'Use either a valid primitive prefab or a local model path.');
                if (o.anim || o.clip) fail(i, 'prefab', 'Primitive prefabs do not support model animations.');
            } else if (!this.assetPath(o.model) || !/\.(fbx|glb|gltf)$/i.test(o.model)) fail(i, 'model', 'Expected a local model path or primitive prefab.');
            if (!this.objectKinds.includes(o.kind)) fail(i, 'kind', 'Expected actor or prop.');
            for (const key of ['x', 'y', 'h']) if (!Number.isFinite(o[key])) fail(i, key, 'Expected a finite number.');
            for (const key of ['rot', 'scale']) if (!Array.isArray(o[key]) || o[key].length !== 3 || !o[key].every(Number.isFinite) || (key === 'scale' && o[key].some(v => v <= 0))) fail(i, key, 'Expected a three-number vector; scale must be positive.');
            if (o.components != null && (!this.json(o.components) || Array.isArray(o.components) || typeof o.components !== 'object' || !o.components)) fail(i, 'components', 'Expected a plain JSON component map.');
            if (o.physics != null && !this.validPhysics(o.physics)) fail(i, 'physics', 'Invalid physics body: check motion, shape, dimensions, mass, friction and restitution.');
            if (o.anim && (!this.animAxes.includes(o.anim.axis) || !['cw', 'ccw'].includes(o.anim.dir) || !Number.isFinite(o.anim.speed) || o.anim.speed < 0 || typeof o.anim.part !== 'string' || !o.anim.part)) fail(i, 'anim', 'Invalid part animation.');
            if (o.sound && (!this.assetPath(o.sound.src) || !/\.(wav|mp3|ogg)$/i.test(o.sound.src))) fail(i, 'sound', 'Expected a local sound path.');
            if (o.sound) {
                for (const key of ['volume', 'falloffMin', 'falloffMax']) if (o.sound[key] != null && (!Number.isFinite(o.sound[key]) || o.sound[key] < 0 || key === 'volume' && o.sound[key] > 1)) fail(i, 'sound.' + key, 'Invalid sound value.');
                if (o.sound.loop != null && typeof o.sound.loop !== 'boolean') fail(i, 'sound.loop', 'Expected a boolean.');
            }
            if (o.hidden != null && typeof o.hidden !== 'boolean') fail(i, 'hidden', 'Expected a boolean.');
            for (const key of ['tag', 'clip']) if (o[key] != null && typeof o[key] !== 'string') fail(i, key, 'Expected a string.');
        });
        return out;
    },
    validateUI(elements) {
        const file = 'js/UILayout.js', out = [], ids = new Set();
        const fail = (i, field, message) => out.push(this.diagnostic('UI_ELEMENT_INVALID', file, i, field, message, 'Correct the UI record or its parent reference.'));
        if (!Array.isArray(elements)) return [this.diagnostic('UI_NOT_ARRAY', file, -1, '', 'Expected an array.', 'Use UI_LAYOUT = [...].')];
        elements.forEach((e, i) => {
            if (!e || typeof e !== 'object') { fail(i, '', 'Expected an object.'); return; }
            if (!this.id(e.id) || ids.has(e.id)) fail(i, 'id', 'UI ID must be valid and unique.');
            ids.add(e.id);
            if (!this.kinds.includes(e.kind)) fail(i, 'kind', 'Unknown UI kind.');
            if (!this.anchors.includes(e.anchor)) fail(i, 'anchor', 'Unknown anchor.');
            for (const [field, type] of Object.entries(this.uiTypes)) {
                if (e[field] == null) continue;
                const value = e[field];
                if (['px', 'size', 'unit'].includes(type) && (!Number.isFinite(value) || (type === 'size' && value < 0) || (type === 'unit' && (value < 0 || value > 1)))) fail(i, field, 'Invalid numeric value.');
                if (type === 'color' && value !== '' && !/^#[0-9a-f]{6}$/i.test(value)) fail(i, field, 'Expected #rrggbb or empty.');
                if (type === 'boolean' && typeof value !== 'boolean') fail(i, field, 'Expected true or false.');
                if (type === 'text' && typeof value !== 'string') fail(i, field, 'Expected text.');
                if (type === 'flag' && ![0, 1, false, true].includes(value)) fail(i, field, 'Expected 0 or 1.');
                if (type === 'stretch' && !['', 'h', 'v', 'both'].includes(value)) fail(i, field, 'Expected h, v, both or empty.');
                if (type === 'id' && value !== '' && !this.id(value)) fail(i, field, 'Expected an element ID.');
            }
            if (e.components != null && (!this.json(e.components) || typeof e.components !== 'object' || Array.isArray(e.components))) fail(i, 'components', 'Expected a JSON component map.');
        });
        const byId = new Map(elements.filter(Boolean).map(e => [e.id, e]));
        elements.forEach((e, i) => {
            if (!e) return;
            const seen = new Set([e.id]);
            for (let parent = e.parent; parent; parent = byId.get(parent).parent) {
                if (!byId.has(parent) || seen.has(parent)) { fail(i, 'parent', 'Missing parent or parent cycle.'); break; }
                seen.add(parent);
            }
        });
        return out;
    },
    migrateObjects(objects) {
        const result = JSON.parse(JSON.stringify(objects)), used = new Set(result.map(o => o.id).filter(Boolean));
        result.forEach((o, i) => {
            if (o.id) return;
            let base = String(o.name || 'object').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
            if (!/^[A-Za-z_]/.test(base)) base = 'object_' + base;
            let id = base, n = i + 1;
            while (used.has(id)) id = base + '_' + n++;
            o.id = id; used.add(id);
        });
        return { version: this.version, objects: result, changed: JSON.stringify(objects) !== JSON.stringify(result) };
    },
    // Only literals are accepted: arrays, records, finite numbers, strings, booleans/null.
    // Function calls, identifiers, getters, interpolation and prototype keys cannot execute.
    parseLiteral(source, offset = 0) {
        let at = offset;
        const fail = () => { throw new SyntaxError('DATA_LITERAL_INVALID at ' + at); };
        const skip = () => {
            for (;;) {
                while (/\s/.test(source[at] || '') && at < source.length) at++;
                if (source.slice(at, at + 2) === '//') { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end + 1; }
                else if (source.slice(at, at + 2) === '/*') { const end = source.indexOf('*/', at + 2); if (end < 0) fail(); at = end + 2; }
                else break;
            }
        };
        const string = () => {
            const quote = source[at++]; let out = '';
            while (at < source.length) {
                let ch = source[at++]; if (ch === quote) return out;
                if (ch === '\n' || ch === '\r') fail();
                if (ch === '\\') {
                    ch = source[at++];
                    if (ch === 'u' || ch === 'x') {
                        const n = ch === 'u' ? 4 : 2, hex = source.slice(at, at + n);
                        if (!new RegExp('^[0-9a-f]{' + n + '}$', 'i').test(hex)) fail();
                        out += String.fromCharCode(parseInt(hex, 16)); at += n;
                    } else {
                        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
                        if (!(ch in escapes)) fail(); out += escapes[ch];
                    }
                } else out += ch;
            }
            return fail();
        };
        const value = (depth) => {
            if (depth > 20) fail(); skip(); const ch = source[at];
            if (ch === '"' || ch === "'") return string();
            if (ch === '[' || ch === '{') {
                const array = ch === '[', close = array ? ']' : '}', out = array ? [] : {};
                at++; skip();
                while (source[at] !== close) {
                    if (at >= source.length) fail();
                    if (array) out.push(value(depth + 1));
                    else {
                        skip(); let key;
                        if (source[at] === '"' || source[at] === "'") key = string();
                        else { const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(at)); if (!m) fail(); key = m[0]; at += key.length; }
                        if (['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(out, key)) fail();
                        skip(); if (source[at++] !== ':') fail(); out[key] = value(depth + 1);
                    }
                    skip(); if (source[at] === close) break;
                    if (source[at++] !== ',') fail(); skip();
                }
                at++; return out;
            }
            const token = /^(?:-?(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|true\b|false\b|null\b)/i.exec(source.slice(at));
            if (!token) return fail(); at += token[0].length;
            if (token[0] === 'true') return true; if (token[0] === 'false') return false; if (token[0] === 'null') return null;
            const n = Number(token[0]); if (!Number.isFinite(n)) fail(); return n;
        };
        const result = value(0); skip();
        return { value: result, end: at };
    },
    declarationMask(source) {
        // Preserve offsets, but declarations written inside comments/strings are not code.
        let out = '', at = 0;
        while (at < source.length) {
            const ch = source[at], next = source[at + 1];
            if (ch === '/' && (next === '/' || next === '*')) {
                const line = next === '/', start = at;
                at = line ? source.indexOf('\n', at + 2) : source.indexOf('*/', at + 2);
                if (at < 0) { if (!line) throw new SyntaxError('DATA_COMMENT_UNCLOSED'); at = source.length; }
                else if (!line) at += 2;
                out += source.slice(start, at).replace(/[^\r\n]/g, ' ');
            } else if (ch === "'" || ch === '"' || ch === '`') {
                const start = at++, quote = ch;
                while (at < source.length) { const c = source[at++]; if (c === '\\') at++; else if (c === quote) break; }
                out += '~'.repeat(at - start);
            } else { out += ch; at++; }
        }
        return out;
    },
    documentVersion(source) {
        const markers = [...source.matchAll(/^\s*\/\/\s*schema-version:\s*([^\r\n]*)/gm)];
        if (!markers.length) return 0;
        if (markers.length !== 1 || !/^\d+$/.test(markers[0][1].trim())) throw new Error('DATA_VERSION_INVALID');
        const version = Number(markers[0][1]);
        if (!Number.isSafeInteger(version) || version > this.version) throw new Error('DATA_VERSION_UNSUPPORTED: ' + version);
        return version;
    },
    parseDocument(source, declaration) {
        this.documentVersion(source);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(declaration)) throw new Error('DATA_DECLARATION_INVALID');
        const matches = [...this.declarationMask(source).matchAll(new RegExp('^\\s*(?:const|let|var)\\s+' + declaration + '\\s*=\\s*', 'gm'))];
        if (matches.length > 1) throw new Error('DATA_DECLARATION_DUPLICATE: ' + declaration);
        const match = matches[0];
        if (!match) throw new Error('DATA_DECLARATION_MISSING: ' + declaration);
        const parsed = this.parseLiteral(source, match.index + match[0].length);
        if (source[parsed.end] !== ';') throw new Error('DATA_EXPRESSION_FORBIDDEN');
        return parsed.value;
    },
    projectConfig(source) {
        const mask = this.declarationMask(source);
        if (!/^\s*(?:const|let|var)\s+PROJECT_CONFIG\s*=/m.test(mask)) return {};
        const entries = this.parseDocument(source, 'PROJECT_CONFIG');
        this.validateProjectConfig(entries);
        return entries;
    },
    validateProjectConfig(entries) {
        if (!entries || Array.isArray(entries) || typeof entries !== 'object' || !this.json(entries)) throw new Error('PROJECT_CONFIG_INVALID');
        for (const [name, field] of Object.entries(entries)) {
            const allowed = ['value', 'default', 'min', 'max', 'step', 'label', 'hint', 'units', 'kind', 'options'];
            if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name === 'PROJECT_CONFIG' || !field || Array.isArray(field) || typeof field !== 'object' || Object.keys(field).some(k => !allowed.includes(k))) throw new Error('PROJECT_CONFIG_FIELD_INVALID: ' + name);
            if (!Number.isFinite(field.value) || (field.default != null && !Number.isFinite(field.default))) throw new Error('PROJECT_CONFIG_VALUE_INVALID: ' + name);
            for (const key of ['label', 'hint']) if (field[key] != null && (typeof field[key] !== 'object' || Array.isArray(field[key]) || Object.values(field[key]).some(v => typeof v !== 'string'))) throw new Error('PROJECT_CONFIG_LABEL_INVALID: ' + name);
            if (field.units != null && typeof field.units !== 'string') throw new Error('PROJECT_CONFIG_UNITS_INVALID: ' + name);
            if (field.kind != null && !['color', 'select', 'number'].includes(field.kind)) throw new Error('PROJECT_CONFIG_KIND_INVALID: ' + name);
            for (const key of ['min', 'max', 'step']) if (field[key] != null && !Number.isFinite(field[key])) throw new Error('PROJECT_CONFIG_RANGE_INVALID: ' + name);
            if ((field.min != null && field.max != null && field.min > field.max) || (field.step != null && field.step <= 0)) throw new Error('PROJECT_CONFIG_RANGE_INVALID: ' + name);
            if (field.kind === 'select' && (!Array.isArray(field.options) || !field.options.length || field.options.some(o => !o || !Number.isFinite(o.value) || !o.label || typeof o.label !== 'object' || Object.values(o.label).some(v => typeof v !== 'string')))) throw new Error('PROJECT_CONFIG_OPTIONS_INVALID: ' + name);
        }
        return entries;
    },
    parseConstants(source) {
        this.documentVersion(source);
        const values = {};
        for (const match of this.declarationMask(source).matchAll(/^\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*/gm)) {
            if (match[1] === 'IS_MOBILE' || match[1] === 'PROJECT_CONFIG') continue;
            if (Object.hasOwn(values, match[1])) throw new Error('CONFIG_DECLARATION_DUPLICATE: ' + match[1]);
            const parsed = this.parseLiteral(source, match.index + match[0].length);
            if (source[parsed.end] !== ';' || !['number', 'string', 'boolean'].includes(typeof parsed.value)) throw new Error('CONFIG_LITERAL_INVALID: ' + match[1]);
            values[match[1]] = parsed.value;
        }
        for (const [name, field] of Object.entries(this.projectConfig(source))) {
            if (Object.hasOwn(values, name)) throw new Error('CONFIG_DECLARATION_DUPLICATE: ' + name);
            values[name] = field.value;
        }
        if (values.LOCATION_GROUND_TEXTURE != null && (typeof values.LOCATION_GROUND_TEXTURE !== 'string' || values.LOCATION_GROUND_TEXTURE !== '' && (!this.assetPath(values.LOCATION_GROUND_TEXTURE) || !/\.(png|jpe?g|webp)$/i.test(values.LOCATION_GROUND_TEXTURE)))) throw new Error('GROUND_TEXTURE_PATH_INVALID');
        if (Object.hasOwn(values, 'PHYSICS_ENABLED') && ![0, 1].includes(values.PHYSICS_ENABLED)) throw new Error('PHYSICS_ENABLED_INVALID: expected 0 or 1');
        if (Object.hasOwn(values, 'PHYSICS_GRAVITY') && !Number.isFinite(values.PHYSICS_GRAVITY)) throw new Error('PHYSICS_GRAVITY_INVALID: expected finite cm/s^2');
        return values;
    }
};
