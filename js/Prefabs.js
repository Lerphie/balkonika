// Prefabs.js — declarative primitives shared by game and editor; no game factory execution.
/** @satisfies {Record<string, any>} */
const ArcPrefabs = {
    /** @param {ArcPrefabDef} definition @param {BABYLON.Scene} scene @param {string} name */
    build(definition, scene, name = 'prefab') {
        if (!ArcSchema.validPrefab(definition)) throw new Error('PREFAB_INVALID: ' + name);
        const root = new BABYLON.Mesh(name, scene), materials = [];
        try {
            for (const part of definition.parts) {
                const label = name + ':' + part.id;
                const mesh = part.shape === 'box' ? BABYLON.MeshBuilder.CreateBox(label, { size: 1 }, scene)
                    : part.shape === 'sphere' ? BABYLON.MeshBuilder.CreateSphere(label, { diameter: 1, segments: 8 }, scene)
                    : part.shape === 'cylinder' ? BABYLON.MeshBuilder.CreateCylinder(label, { height: 1, diameter: 1, tessellation: 12 }, scene)
                    : BABYLON.MeshBuilder.CreateGround(label, { width: 1, height: 1 }, scene);
                mesh.parent = root;
                mesh.scaling.copyFromFloats(...part.size);
                const position = part.position || [0, 0, 0], rotation = part.rotation || [0, 0, 0];
                mesh.position.copyFromFloats(position[0], position[1], position[2]);
                mesh.rotation.copyFromFloats(rotation[0] * Math.PI / 180, rotation[1] * Math.PI / 180, rotation[2] * Math.PI / 180);
                const material = new BABYLON.StandardMaterial(label + ':material', scene);
                materials.push(material);
                material.diffuseColor = BABYLON.Color3.FromHexString(part.color || '#ffffff');
                mesh.material = material;
                mesh.metadata = { prefabPart: part.id };
            }
            root.onDisposeObservable.add(() => { for (const material of materials) material.dispose(); });
            return root;
        } catch (error) {
            root.dispose();
            for (const material of materials) material.dispose();
            throw error;
        }
    }
};
