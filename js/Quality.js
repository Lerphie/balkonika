// Quality.js — explicit presets and scene budgets; no claim about a device's frame rate.
/** @satisfies {Record<string, any>} */
const ArcQuality = {
    current: 'custom',
    profiles: {
        low: { pixelRatio: 1, shadowMap: 512, shadowSoft: 0, outline: 1, budget: { meshes: 300, triangles: 250000, textures: 64 } },
        balanced: { pixelRatio: 1.5, shadowMap: 1024, shadowSoft: 1, outline: 2, budget: { meshes: 700, triangles: 600000, textures: 128 } },
        high: { pixelRatio: 2, shadowMap: 2048, shadowSoft: 2, outline: 2, budget: { meshes: 1000, triangles: 1200000, textures: 256 } }
    },
    apply(name) {
        const profile = this.profiles[name];
        if (!profile) throw new Error('QUALITY_PROFILE_UNKNOWN');
        if (!World3D.engine) throw new Error('ENGINE_NOT_READY');
        ArcConfig.set('WORLD3D_SHADOW_MAP', profile.shadowMap);
        ArcConfig.set('WORLD3D_SHADOW_SOFT', profile.shadowSoft);
        ArcConfig.set('WORLD3D_TOON_OUTLINE', profile.outline);
        World3D.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, profile.pixelRatio));
        if (World3D.view) World3D.applyRenderConstants(World3D.view);
        World3D.resize(); this.current = name;
        return { name, ...profile };
    },
    inspect(scene = World3D.view && World3D.view.scene) {
        if (!scene) return { profile: this.current, stats: null, findings: [] };
        const stats = { meshes: scene.meshes.length, textures: scene.textures.length,
            triangles: scene.meshes.reduce((sum, mesh) => sum + (mesh.getTotalIndices ? mesh.getTotalIndices() / 3 : 0) * (mesh instanceof BABYLON.Mesh && mesh.hasThinInstances ? mesh.thinInstanceCount : 1), 0) };
        const profile = this.profiles[this.current] || this.profiles.balanced;
        const findings = Object.keys(profile.budget).filter(key => stats[key] > profile.budget[key]).map(key => ({ severity: 'warning', code: 'SCENE_BUDGET_EXCEEDED', metric: key, actual: stats[key], budget: profile.budget[key], hint: 'Measure this scene, then consider instancing, asset simplification or a lower quality profile.' }));
        return { profile: this.current, stats, budget: profile.budget, findings };
    }
};
