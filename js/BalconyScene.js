// BalconyScene owns the fixed presentation camera and all finish materials.
// The three floor maps are baked locally and loaded once per scene.
class BalconyScene {
    /** @param {ArcApp} app */
    constructor(app) {
        this.view = app.location.view;
        this.scene = this.view.scene;
        this.meshes = [];
        this.materials = [];
        this.textures = [];
        for (const mesh of app.location.terrain.meshes) mesh.setEnabled(false);
        this.scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
        this.scene.clearColor = new BABYLON.Color4(0.83, 0.89, 0.90, 1);
        this.view.hemi.intensity = 0.84;
        this.view.hemi.diffuse = new BABYLON.Color3(1, 0.98, 0.95);
        this.view.hemi.groundColor = new BABYLON.Color3(0.90, 0.89, 0.85);
        this.view.sun.intensity = 0.35;

        this.camera = new BABYLON.TargetCamera('balcony-fixed-camera', new BABYLON.Vector3(-4, 155, -242), this.scene);
        this.camera.minZ = 1;
        this.camera.maxZ = 2000;
        this.camera.fov = 72 * Math.PI / 180;
        this.camera.setTarget(new BABYLON.Vector3(2, 105, 130));
        this.scene.activeCamera = this.camera;

        this.wallMaterial = this.material('walls', '#ecebe7');
        this.wallMaterial.emissiveColor = new BABYLON.Color3(0.18, 0.18, 0.18);
        const white = this.material('window-frame', '#f2f1ea');
        const frameSide = this.material('window-frame-shadow', '#c5c9c6');
        const ceiling = this.material('ceiling', '#f6f5ef');
        ceiling.emissiveColor = new BABYLON.Color3(0.20, 0.20, 0.19);
        const sky = this.material('outside-sky', '#b8d5dc', true);
        const landscape = this.material('outside-landscape', '#c7d8d0', true);
        const glass = this.material('glass', '#e1eff0');
        glass.alpha = 0.18;
        glass.specularColor = new BABYLON.Color3(0.25, 0.25, 0.25);

        this.floorMaterials = {
            lightWood: this.floorMaterial('light-wood', 'assets/balkonika/light-wood.png'),
            darkWood: this.floorMaterial('dark-wood', 'assets/balkonika/dark-wood.png'),
            grayTile: this.floorMaterial('gray-tile', 'assets/balkonika/gray-tile.png')
        };
        this.floor = BABYLON.MeshBuilder.CreateGround('balcony-floor', { width: 280, height: 560 }, this.scene);
        this.floor.position.set(0, 0, -20);
        this.floor.material = this.floorMaterials.lightWood;
        this.register(this.floor);

        // Solid surfaces are boxes so the viewer always sees their correctly wound faces.
        this.box('left-wall', [-143, 125, -20], [6, 250, 560], this.wallMaterial);
        this.box('end-wall', [0, 125, 263], [280, 250, 6], this.wallMaterial);
        this.box('right-low-wall', [143, 49, -20], [6, 98, 560], this.wallMaterial);
        this.box('ceiling', [0, 253, -20], [280, 6, 560], ceiling);

        // The plaster return belongs to the wall and meets the end wall at z=260.
        // Window components stop at its near face (z=254), instead of crossing the corner.
        this.box('window-end-return', [127.5, 174, 257], [25, 152, 6], this.wallMaterial);

        // Opaque outdoor planes and transparent glass are owned separately from finishes.
        this.box('daylight', [158, 171, -23], [2, 150, 554], sky);
        this.box('distant-horizon', [156, 110, -23], [2, 26, 554], landscape);
        this.box('window-glass', [143, 171, -21], [1, 140, 550], glass);
        this.box('window-sill', [131, 99, -23], [32, 7, 554], white);
        this.box('sill-shadow', [139, 94, -23], [13, 3, 554], frameSide);
        this.box('frame-top', [141, 244, -23], [12, 10, 554], white);
        this.box('frame-bottom', [141, 108, -23], [12, 7, 554], white);
        for (let z = -296; z <= 260; z += 93) {
            this.box('window-mullion-' + z, [140, 176, z], [12, 137, 7], white);
            this.box('mullion-edge-' + z, [133, 176, z + 3], [2, 137, 2], frameSide);
        }
        this.box('window-end-mullion', [140, 176, 250.5], [12, 137, 7], white);
        this.box('window-end-mullion-edge', [133, 176, 253], [2, 137, 2], frameSide);
        this.box('window-midrail', [140, 166, -20.5], [10, 5, 549], white);
        this.setWall('white');
    }

    /** @param {string} name @param {string} hex @param {boolean} [unlit] */
    material(name, hex, unlit = false) {
        const material = new BABYLON.StandardMaterial('balcony-' + name, this.scene);
        material.diffuseColor = BABYLON.Color3.FromHexString(hex);
        material.specularColor = new BABYLON.Color3(0, 0, 0);
        material.metadata = { toon: false };
        if (unlit) {
            material.disableLighting = true;
            material.emissiveColor = BABYLON.Color3.FromHexString(hex);
        }
        this.materials.push(material);
        return material;
    }

    /** @param {string} name @param {string} path */
    floorMaterial(name, path) {
        const material = this.material(name, '#ffffff');
        const texture = new BABYLON.Texture(path, this.scene, false, false);
        texture.anisotropicFilteringLevel = 8;
        material.diffuseTexture = texture;
        this.textures.push(texture);
        return material;
    }

    /** @param {BABYLON.AbstractMesh} mesh */
    register(mesh) {
        World3D.addObject(this.view, mesh, 'prop', { castShadow: false, receiveShadows: false, ink: false, outline: false });
        mesh.isPickable = false;
        this.meshes.push(mesh);
    }

    /** @param {string} name @param {number[]} position @param {number[]} dimensions @param {BABYLON.StandardMaterial} material */
    box(name, position, dimensions, material) {
        const mesh = BABYLON.MeshBuilder.CreateBox(name, { width: dimensions[0], height: dimensions[1], depth: dimensions[2] }, this.scene);
        mesh.position.set(position[0], position[1], position[2]);
        mesh.material = material;
        this.register(mesh);
        return mesh;
    }

    /** @param {string} value */
    setWall(value) {
        const colors = { white: '#ecebe7', beige: '#d7c4a9', lightGray: '#b9c1c2' };
        if (Object.hasOwn(colors, value)) this.wallMaterial.diffuseColor = BABYLON.Color3.FromHexString(colors[value]);
    }

    /** @param {string} value */
    setFloor(value) {
        if (Object.hasOwn(this.floorMaterials, value)) this.floor.material = this.floorMaterials[value];
    }

    dispose() {
        for (const mesh of this.meshes) World3D.removeObject(this.view, mesh);
        for (const material of this.materials) material.dispose(false, false);
        for (const texture of this.textures) texture.dispose();
        this.camera.dispose();
        this.scene.activeCamera = this.view.camera;
    }
}

