// Toon3D.js — StandardMaterial toon/shadow plugin and its shared state.
// Load after World3D.js; registration occurs in World3D.init before materials exist.
// Babylon supplies sun visibility; ARCSHADOW colors it with the configured shadow color
// and strength. The sun is the final scene light, after the hemisphere light, and its
// direction/color come from scene.metadata.arcSun. Preserve that light order.
// --- Toon material plugin -------------------------------------------------------

// StandardMaterial plugin. Lives on every material (material.arcToon). Two
// independent defines:
//   ARCSHADOW — colored shadow (see the file header): on all lit materials
//               of a scene that has scene.metadata.arcSun (set by
//               View3D.applyLighting);
//   ARCTOON   — light bands (World3D.toon.s.on).
// Values go out as uniforms on every bind (no shader rebuild),
// defines — on markAllDefinesAsDirty. Materials of the 'ground' group get
// bands = 0 when WORLD3D_TOON_GROUND is off, and rim light 0 — branching in the
// shader, not in a define, so that the editor's toggles do not recompile
// shaders. metadata.toon = false turns the bands off on a material.
class ArcToonPlugin extends BABYLON.MaterialPluginBase {
    constructor(material) {
        super(material, 'ArcToon', 500, { ARCTOON: false, ARCSHADOW: false }, true, true);
    }

    getClassName() { return 'ArcToonPlugin'; }

    prepareDefines(defines, scene, mesh) {
        const s = World3D.toon.s;
        const m = /** @type {BABYLON.StandardMaterial} */ (this._material);
        const lit = !m.disableLighting;
        // The stock attribute helper only raises INSTANCESCOLOR. A thin batch can
        // become empty, or a readiness check can request a non-instanced variant.
        // That variant must not reference instanceColor: Babylon declares it only
        // under INSTANCES. Derive both directions from this exact draw variant.
        const instanceColor = !!(defines.INSTANCES &&
            mesh.isVerticesDataPresent(BABYLON.VertexBuffer.ColorInstanceKind) &&
            (mesh.hasInstances || mesh.hasThinInstances));
        if (defines.INSTANCESCOLOR !== instanceColor) {
            defines.INSTANCESCOLOR = instanceColor;
            defines.markAsUnprocessed();
        }
        defines.ARCTOON = !!(s.on && lit && !(m.metadata && m.metadata.toon === false));
        defines.ARCSHADOW = !!(lit && scene.metadata && scene.metadata.arcSun);
    }

    getUniforms() {
        return {
            ubo: [
                { name: 'arcToonA', size: 4, type: 'vec4' },
                { name: 'arcToonB', size: 4, type: 'vec4' },
                { name: 'arcShadowColor', size: 4, type: 'vec4' },
                { name: 'arcSunDir', size: 4, type: 'vec4' },
                { name: 'arcSunColor', size: 4, type: 'vec4' }
            ],
            fragment: '#ifdef ARCTOON\nuniform vec4 arcToonA;\nuniform vec4 arcToonB;\n#endif\n' +
                '#ifdef ARCSHADOW\nuniform vec4 arcShadowColor;\nuniform vec4 arcSunDir;\nuniform vec4 arcSunColor;\n#endif'
        };
    }

    bindForSubMesh(ubo, scene, engine, subMesh) {
        const s = World3D.toon.s;
        const m = this._material;
        const md = scene.metadata;
        if (md && md.arcSun) {
            const sun = md.arcSun, sh = md.arcShadow || {};
            const col = sh.color || World3D.hexColor3(0x012d3c);
            ubo.updateFloat4('arcShadowColor', col.r, col.g, col.b, sh.strength != null ? sh.strength : 0.36);
            ubo.updateFloat4('arcSunDir', sun.dir.x, sun.dir.y, sun.dir.z, 0);
            ubo.updateFloat4('arcSunColor', sun.color.r, sun.color.g, sun.color.b, 0);
        }
        const ground = !!(m.metadata && m.metadata.toonGroup === 'ground');
        const bands = (ground && !s.ground) ? 0 : s.bands;
        ubo.updateFloat4('arcToonA', bands, s.soft, s.low, s.spec);
        ubo.updateFloat4('arcToonB', s.specSize, ground ? 0 : s.rim, s.rimWidth, 0);
    }

    getCustomCode(shaderType) {
        return shaderType === 'fragment' ? ArcToonPlugin.CODE : null;
    }
}

// arcToonA = (bands, softness, lowest band, specular highlight strength),
// arcToonB = (specular highlight threshold, rim light strength, rim light width, —),
// arcShadowColor = (shadow color, strength), arcSunDir = toward the sun, arcSunColor =
// sun diffuse × intensity (like Babylon's vLightDiffuse).
ArcToonPlugin.CODE = {
    CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef ARCTOON
float arcToonLevel(float v) {
    float bands = arcToonA.x;
    float lo = arcToonA.z;
    float t = clamp((v - lo) / max(1e-4, 1.0 - lo), 0.0, 1.0);
    float x = t * (bands - 1.0);
    float k = floor(x + 0.5);
    float d = x - k;
    float s = max(1e-3, arcToonA.y);
    float q = k + smoothstep(0.5 - s, 0.5 + s, d) - smoothstep(0.5 - s, 0.5 + s, -d);
    return lo + clamp(q / (bands - 1.0), 0.0, 1.0) * (1.0 - lo);
}
#endif
`,
    // Shadow fraction at the point — shared by the colored shadow and the toon rim light.
    CUSTOM_FRAGMENT_MAIN_BEGIN: `
float arcShadowA = 0.0;
`,
    // Right after the light of all sources is summed (default.fragment):
    // diffuseBase and specularBase are not yet multiplied by color/texture. First
    // the colored shadow: the sun visibility is the shadow variable of the LAST light
    // (the sun; generator darkness 0), the unshadowed light is reconstructed
    // by adding back the hidden fraction of the sun.
    '!!aggShadow=aggShadow/numLights;': `$0
#ifdef ARCSHADOW
{
    float arcV = clamp(shadow, 0.0, 1.0);
    vec3 arcSunD = arcSunColor.rgb * max(0.0, dot(normalW, arcSunDir.xyz));
    vec3 arcU = max(vec3(0.0), diffuseBase + arcSunD * (1.0 - arcV));
    arcShadowA = 1.0 - arcV;
    diffuseBase = arcU * mix(vec3(1.0), arcShadowColor.rgb, arcShadowA * arcShadowColor.a);
#ifdef SPECULARTERM
    specularBase *= 1.0 - arcShadowA;
#endif
}
#endif
#ifdef ARCTOON
if (arcToonA.x >= 1.5) {
    float arcV = max(diffuseBase.r, max(diffuseBase.g, diffuseBase.b));
    float arcQ = arcToonLevel(arcV);
    diffuseBase = arcV > 1e-4 ? diffuseBase * (arcQ / arcV) : vec3(arcQ);
#ifdef SPECULARTERM
    float arcS = max(specularBase.r, max(specularBase.g, specularBase.b));
    float arcW = max(0.005, arcToonA.y * 0.25);
    float arcH = smoothstep(arcToonB.x - arcW, arcToonB.x + arcW, arcS) * arcToonA.w;
    specularBase = (arcS > 1e-5 ? specularBase / arcS : vec3(0.0)) * arcH;
#endif
}
#endif
`,
    // Rim light along the silhouette edge — lighter than the base color, fades out in shadow.
    CUSTOM_FRAGMENT_BEFORE_FOG: `
#ifdef ARCTOON
if (arcToonB.y > 0.0) {
    float arcF = 1.0 - max(0.0, dot(normalW, viewDirectionW));
    float arcE = 1.0 - arcToonB.z;
    float arcR = smoothstep(arcE - 0.05, arcE + 0.05, arcF) * arcToonB.y * (1.0 - arcShadowA);
    color.rgb += baseColor.rgb * arcR;
}
#endif
`
};

/** @satisfies {Record<string, any>} */
const ArcToon = {
    s: { on: true, bands: 3, soft: 0.06, low: 0.35, ground: true, spec: 1, specSize: 0.12, rim: 0.25, rimWidth: 0.35 },
    registered: false,

    // Once per page: the factory attaches the plugin to every new StandardMaterial
    // (material creation event). GLSL (WebGL) only — like the whole world.
    register() {
        if (this.registered || typeof BABYLON === 'undefined' || !BABYLON.MaterialPluginBase ||
            typeof BABYLON.RegisterMaterialPlugin !== 'function') return;
        this.registered = true;
        this.load(World3D.cfg());
        BABYLON.RegisterMaterialPlugin('ArcToon', (material) => {
            if (!(material instanceof BABYLON.StandardMaterial)) return null;
            if (material.shaderLanguage != null && material.shaderLanguage !== 0) return null;
            material.arcToon = new ArcToonPlugin(material);
            return material.arcToon;
        });
    },

    load(c) {
        this.s = {
            on: c.toon > 0,
            bands: Math.max(2, Math.min(8, Math.round(c.toonBands))),
            soft: Math.max(0, Math.min(0.5, c.toonSoft)),
            low: Math.max(0, Math.min(0.95, c.toonLow)),
            ground: c.toonGround > 0,
            spec: Math.max(0, c.toonSpec),
            specSize: Math.max(0.005, c.toonSpecSize),
            rim: Math.max(0, c.toonRim),
            rimWidth: Math.max(0.02, Math.min(0.95, c.toonRimWidth))
        };
    },

    // New constants: values — as uniforms on the next bind; on/off
    // — a shader rebuild of all materials with the plugin in all engines of the page.
    apply(c) {
        const wasOn = this.s.on;
        this.load(c || World3D.cfg());
        if (wasOn === this.s.on || !BABYLON.EngineStore) return;
        for (const eng of BABYLON.EngineStore.Instances) {
            for (const sc of eng.scenes) {
                for (const m of sc.materials) if (m.arcToon) m.arcToon.markAllDefinesAsDirty();
                sc.resetCachedMaterial();
            }
        }
    }
};
World3D.toon = ArcToon;
