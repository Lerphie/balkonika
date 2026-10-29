// Bindings.js — the sample's declarative dependencies, shared by runtime and tooling.
/** @satisfies {Record<string, any>} */
const ArcBindings = {
    editorContract: 'balkonikaContract',
    balkonikaContract: {
        "version": 1,
        "name": "balkonika",
        "ui": [
            {
                "id": "heading",
                "kind": "text",
                "required": true
            },
            {
                "id": "wall_white",
                "kind": "button",
                "required": true
            },
            {
                "id": "wall_beige",
                "kind": "button",
                "required": true
            },
            {
                "id": "wall_lightGray",
                "kind": "button",
                "required": true
            },
            {
                "id": "floor_lightWood",
                "kind": "button",
                "required": true
            },
            {
                "id": "floor_darkWood",
                "kind": "button",
                "required": true
            },
            {
                "id": "floor_grayTile",
                "kind": "button",
                "required": true
            },
            {
                "id": "selection",
                "kind": "text",
                "required": true
            },
            {
                "id": "reset",
                "kind": "button",
                "required": true
            }
        ],
        "objects": [],
        "assets": [
            {
                "id": "reference-photo",
                "path": "assets/balkonika/photo-v4/reference-photo.jpg",
                "required": true
            },
            {
                "id": "walls-beige",
                "path": "assets/balkonika/photo-v4/walls-beige.png",
                "required": true
            },
            {
                "id": "walls-lightgray",
                "path": "assets/balkonika/photo-v4/walls-lightgray.png",
                "required": true
            },
            {
                "id": "floor-dark-wood",
                "path": "assets/balkonika/photo-v4/floor-dark-wood.png",
                "required": true
            },
            {
                "id": "floor-gray-tile",
                "path": "assets/balkonika/photo-v4/floor-gray-tile.png",
                "required": true
            },
            {
                "id": "ceiling",
                "path": "assets/balkonika/photo-v4/ceiling.png",
                "required": true
            },
            {
                "id": "windows",
                "path": "assets/balkonika/photo-v4/windows.png",
                "required": true
            }
        ]
    },

    finding(rule, code, file, field, message, hint, extra = {}) {
        return { severity: rule.required === false ? 'warning' : 'error', code, file, field, message, hint, ...extra };
    },

    validateData(objects, layout, contract = ArcBindings.balkonikaContract) {
        const out = [], records = Array.isArray(objects) ? objects : [], elements = Array.isArray(layout) ? layout : [];
        for (const rule of contract.ui || []) {
            const found = elements.filter(e => e && e.id === rule.id);
            const extra = { id: rule.id, contract: contract.name };
            if (!found.length) out.push(this.finding(rule, 'UI_REQUIRED_ID_MISSING', 'js/UILayout.js', 'id',
                'UI binding is missing: ' + rule.id, 'Add ' + rule.id + ' as a ' + rule.kind + ', or update the declared game contract.', extra));
            else if (found.length > 1) out.push(this.finding(rule, 'UI_BINDING_AMBIGUOUS', 'js/UILayout.js', 'id',
                'Several UI records use ID ' + rule.id, 'Keep one stable UI ID for this binding.', extra));
            else if (rule.kind && found[0].kind !== rule.kind) out.push(this.finding(rule, 'UI_BINDING_KIND_MISMATCH', 'js/UILayout.js', 'kind',
                rule.id + ' must be a ' + rule.kind + ', found ' + found[0].kind, 'Restore the declared element kind or change the contract.', extra));
        }
        for (const rule of contract.objects || []) {
            const found = records.filter(o => o && o.tag === rule.tag), extra = { tag: rule.tag, contract: contract.name };
            if (found.length < (rule.min == null ? 1 : rule.min)) out.push(this.finding(rule, 'OBJECT_TAG_MISSING', 'js/Objects.js', 'tag',
                'No required object binding for tag ' + rule.tag, 'Assign tag ' + rule.tag + ' to the intended object.', extra));
            else if (rule.max != null && found.length > rule.max) out.push(this.finding(rule, 'OBJECT_TAG_AMBIGUOUS', 'js/Objects.js', 'tag',
                'Too many objects use tag ' + rule.tag, 'Keep at most ' + rule.max + ' object(s) for this binding.', extra));
            for (const object of found) {
                if (object.prefab != null && object.model == null && ArcSchema.validPrefab(object.prefab)) continue;
                if (typeof object.model !== 'string' || !/^assets\/[A-Za-z0-9_./-]+\.(?:fbx|glb|gltf)$/i.test(object.model)
                    || object.model.split('/').some(part => part === '..' || part === '.' || !part)) {
                    out.push(this.finding(rule, 'OBJECT_ASSET_PATH_INVALID', 'js/Objects.js', 'model',
                        'Invalid model path for tag ' + rule.tag, 'Use a model inside assets/ with a literal relative path.', extra));
                }
            }
        }
        for (const rule of contract.assets || []) {
            if (typeof rule.path !== 'string' || !/^assets\/[A-Za-z0-9_./-]+$/.test(rule.path)
                || rule.path.split('/').some(part => part === '..' || part === '.' || !part)) {
                out.push(this.finding(rule, 'BINDING_ASSET_PATH_INVALID', 'js/Bindings.js', 'assets.path',
                    'Invalid asset dependency path.', 'Declare a literal project-relative path inside assets/.'));
            }
        }
        return out;
    },

    // resolveClips(record) returns Clips3D, an array of names, or null for an unavailable model.
    validateRuntime(location, ui, contract = ArcBindings.balkonikaContract, resolveClips = (_record) => null) {
        const records = location && Array.isArray(location.objects) ? location.objects : [];
        const layout = ui && ui.elements ? [...ui.elements.values()].map(e => e.def) : (ui && ui.layout) || [];
        const out = this.validateData(records.map(rec => rec.def), layout, contract);
        for (const rule of contract.objects || []) {
            for (const record of records.filter(rec => rec.def && rec.def.tag === rule.tag)) {
                let clips;
                try { clips = resolveClips(record); } catch { clips = null; }
                const names = Array.isArray(clips) ? clips : clips && typeof clips.names === 'function' ? clips.names() : [];
                for (const name of rule.clips || []) {
                    const exists = clips && typeof clips.has === 'function' ? clips.has(name) : names.includes(name);
                    if (!exists) out.push(this.finding(rule, 'ANIMATION_CLIP_MISSING', record.def.model || 'js/Objects.js', 'animations',
                        'Tag ' + rule.tag + ' requires animation clip ' + name,
                        'Export a model containing ' + (rule.clips || []).join(', ') + ' or update the game contract.',
                        { tag: rule.tag, id: record.def.id, clip: name, contract: contract.name }));
                }
            }
        }
        return out;
    },
};
