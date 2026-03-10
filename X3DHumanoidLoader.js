import * as THREE from 'three';

/**
 * Loads a skinned X3D JSON format character into a THREE.js Scene
 * @param {THREE.Scene} scene - The THREE.js scene to add the mesh to
 * @returns {Promise<{ mesh: THREE.SkinnedMesh, mixer: THREE.AnimationMixer }>}
 */
export async function loadX3DHumanoid(json, scene) {
    const x3dScene = json.X3D['-Scene'];
    const childrenNodes = x3dScene['-children'] || [];
    
    let humanoidNode = null;
    let timeSensor = null;
    const interpolators = [];
    
    for (const child of childrenNodes) {
        if (child.HAnimHumanoid) humanoidNode = child.HAnimHumanoid;
        if (child.TimeSensor) timeSensor = child.TimeSensor;
        if (child.PositionInterpolator || child.OrientationInterpolator) interpolators.push(child);
    }

    if (!humanoidNode) throw new Error("No HAnimHumanoid found in X3D JSON");

    // 1. Parse Geometry
    const skinNode = humanoidNode['-skin'][0].Shape;
    const geoNode = skinNode['-geometry'].TriangleSet || skinNode['-geometry'].IndexedTriangleSet;
    
    const positions = geoNode['-coord'].Coordinate['@point'];
    const uvs = geoNode['-texCoord'] ? geoNode['-texCoord'].TextureCoordinate['@point'] : null;
    const colors = geoNode['-color'] ? geoNode['-color'].Color['@color'] : null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    
    geometry.computeVertexNormals();

    // 2. Parse Material & Textures
    const appearance = skinNode['-appearance'].Appearance;
    const textureNode = appearance['-texture'];
    let material;
    
    if (textureNode && textureNode.ImageTexture) {
        const textureUrl = textureNode.ImageTexture['@url'][0];
        const basePath = "http://localhost:5173/";
        const diffuseMap = new THREE.TextureLoader().load(basePath + textureUrl);
        diffuseMap.colorSpace = THREE.SRGBColorSpace;
        diffuseMap.flipY = false; // Python pre-inverts for WebGL mapping
        
        material = new THREE.MeshStandardMaterial({ map: diffuseMap, vertexColors: !!colors });
    } else {
    	if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        material = new THREE.MeshStandardMaterial({ vertexColors: !!colors });
    }

    // 3. Parse Skeleton & Weights
    const skeletonNodes = humanoidNode['-skeleton'];
    const bones = [];
    const boneMap = {};
    
    const vertexCount = positions.length / 3;
    const skinIndices = new Array(vertexCount * 4).fill(0);
    const skinWeights = new Array(vertexCount * 4).fill(0);
    const weightCounts = new Array(vertexCount).fill(0);
    
    let boneIndex = 0;

    function parseJoint(jointObj, parentBone) {
        const joint = jointObj.HAnimJoint;
        const bone = new THREE.Bone();
        bone.name = joint['@name'];
        
        if (joint['@translation']) bone.position.fromArray(joint['@translation']);
        if (joint['@rotation']) {
            const [x, y, z, angle] = joint['@rotation'];
            bone.quaternion.setFromAxisAngle(new THREE.Vector3(x, y, z), angle); // Axis-Angle to Quat
        }
        if (joint['@scale']) bone.scale.fromArray(joint['@scale']);
        
        bones.push(bone);
        boneMap[joint['@DEF'] || bone.name] = bone;
        if (parentBone) parentBone.add(bone);
        
        // Reverse skin indexing mapped back to vertices
        const indices = joint['@skinCoordIndex'] || [];
        const weights = joint['@skinCoordWeight'] || [];
        
        for (let i = 0; i < indices.length; i++) {
            const vIdx = indices[i];
            const w = weights[i];
            const wc = weightCounts[vIdx];
            if (wc < 4) {
                skinIndices[vIdx * 4 + wc] = boneIndex;
                skinWeights[vIdx * 4 + wc] = w;
                weightCounts[vIdx] += 1;
            }
        }
        
        boneIndex++;
        const children = joint['-children'] || [];
        children.forEach(c => { if (c.HAnimJoint) parseJoint(c, bone); });
        return bone;
    }

    const rootBones = [];
    for (const rootNode of skeletonNodes) {
        rootBones.push(parseJoint(rootNode, null));
    }

    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

    const mesh = new THREE.SkinnedMesh(geometry, material);
    rootBones.forEach(b => mesh.add(b));
    
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    scene.add(mesh);

    // 4. Parse Animation Routing
    const duration = timeSensor ? (timeSensor['@cycleInterval'] || 1) : 1;
    const tracks = [];
    const routes = x3dScene['-ROUTE'] || [];

    for (const interpObj of interpolators) {
        const type = interpObj.PositionInterpolator ? 'PositionInterpolator' : 'OrientationInterpolator';
        const interp = interpObj[type];
        const def = interp['@DEF'];
        
        // Follow X3D route to bone target
        const route = routes.find(r => r.ROUTE && r.ROUTE['@fromNode'] === def && r.ROUTE['@fromField'] === 'value_changed');
        if (!route) continue;

        const targetBone = boneMap[route.ROUTE['@toNode']];
        if (!targetBone) continue;

        const times = interp['@key'].map(k => k * duration);
        
        if (type === 'PositionInterpolator') {
            tracks.push(new THREE.VectorKeyframeTrack(`${targetBone.name}.position`, times, interp['@keyValue']));
        } else {
            const aaValues = interp['@keyValue'];
            const quatValues = [];
            // Re-convert Axis-Angle array stream back to Quaternions per frame
            for(let i = 0; i < aaValues.length; i += 4) {
                const q = new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(aaValues[i], aaValues[i+1], aaValues[i+2]), 
                    aaValues[i+3]
                );
                quatValues.push(q.x, q.y, q.z, q.w);
            }
            tracks.push(new THREE.QuaternionKeyframeTrack(`${targetBone.name}.quaternion`, times, quatValues));
        }
    }

    let mixer = null;
    let animationAction = null;
    if (tracks.length > 0) {
        const clip = new THREE.AnimationClip('X3D_Action', duration, tracks);
        mixer = new THREE.AnimationMixer(mesh);
        animationAction = mixer.clipAction(clip);
        animationAction.play();
    }

    return { mesh, mixer, animationAction };
}
