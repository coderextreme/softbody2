import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';

let physicsWorld, scene, camera, renderer, controls;
let timer = new THREE.Timer();
let rigidBodies = [];
let softBodies = [];
let parsedBodiesMap = {};
const mixers = [];
let globalHinge = null;
let armMovement = 0;
const margin = 0.05;

let transformAux1;
let kinematicBones = [];
let hiddenSkinnedMeshes = []; // Keep track of hidden meshes to manually force their matrix updates

// Reusable temporaries for the animated-jelly COM-relative driving loop.
const _jellyTarget  = new THREE.Vector3();
const _jellyVec     = new THREE.Vector3();
const _jellyMat     = new THREE.Matrix4();
const _animCOM      = new THREE.Vector3();
const _physicsCOM   = new THREE.Vector3();

// --- X3D IMPORT/EXPORT & DEF/USE Registries ---
const globalDefMap = {};
const inlineExportsMap = {};

function scanForDefs(node) {
    if (!node || typeof node !== 'object') return;

    const defName = node["@DEF"] || node["DEF"];
    if (defName) {
        globalDefMap[defName] = node;
    }

    for (const key in node) {
        if (Array.isArray(node[key])) {
            node[key].forEach(child => scanForDefs(child));
        } else if (typeof node[key] === 'object') {
            scanForDefs(node[key]);
        }
    }
}

function scanForExports(node, results = []) {
    if (!node || typeof node !== 'object') return results;

    if (node.EXPORT) {
        results.push(node.EXPORT);
    }

    for (const key in node) {
        if (key === 'EXPORT') {
            if (Array.isArray(node[key])) results.push(...node[key]);
            else results.push(node[key]);
        } else if (Array.isArray(node[key])) {
            node[key].forEach(child => scanForExports(child, results));
        } else if (typeof node[key] === 'object') {
            scanForExports(node[key], results);
        }
    }
    return results;
}

function resolveUSE(node) {
    if (!node) return null;
    if (typeof node === 'object' && !Array.isArray(node)) {
        const useName = node["@USE"] || node["USE"];
        if (useName) {
            const resolved = globalDefMap[useName];
            if (resolved) {
                return resolveUSE(resolved);
            }
            console.warn(`USE node not found in registry: ${useName}`);
            return null;
        }
    }
    return node;
}
// ----------------------------------------------

window.addEventListener('load', () => {
    if (typeof Ammo === 'undefined') {
        document.getElementById('container').innerHTML = "<br><br><br><b>Error:</b> Ammo.js failed to load.";
        return;
    }

    Ammo().then(async (AmmoLib) => {
        window.Ammo = AmmoLib;
        transformAux1 = new Ammo.btTransform();

        await initGraphics();
        initPhysics();
        initInput();

        fetch('scene.json')
            .then(response => {
                if (!response.ok) throw new Error("Could not load scene.json");
                return response.json();
            })
            .then(async (json) => {
                await parseSceneJSON(json.X3D.Scene);
                animate();
            })
            .catch(err => console.error("Error loading scene.json:", err));
    });
});

async function initGraphics() {
    const container = document.getElementById('container');
    container.innerHTML = "";

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 2000);
    scene = new THREE.Scene();

    renderer = new WebGPURenderer({ antialias: true });
    await renderer.init();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    window.addEventListener('resize', onWindowResize, false);
}

function initPhysics() {
    const collisionConfiguration = new Ammo.btSoftBodyRigidBodyCollisionConfiguration();
    const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration);
    const broadphase = new Ammo.btDbvtBroadphase();
    const solver = new Ammo.btSequentialImpulseConstraintSolver();
    const softBodySolver = new Ammo.btDefaultSoftBodySolver();

    physicsWorld = new Ammo.btSoftRigidDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration, softBodySolver);
}

async function parseSceneJSON(sceneData, parentGroup = scene) {
    scanForDefs(sceneData);
    const children = sceneData["-children"];

    if (children) {
        for (const child of children) {
            if (child.Background)           parseBackground(child.Background);
            if (child.Viewpoint)            parseViewpoint(child.Viewpoint);
            if (child.EnvironmentLight)     parseEnvironmentLight(child.EnvironmentLight);
            if (child.DirectionalLight)     parseDirectionalLight(child.DirectionalLight);
            if (child.PointLight)           parsePointLight(child.PointLight);
            if (child.SpotLight)            parseSpotLight(child.SpotLight);
            if (child.Transform)            await parseTransform(child.Transform, parentGroup);
            if (child.Inline)               await processInline(child.Inline, parentGroup);
            if (child.IMPORT)               processImport(child.IMPORT);
            if (child.RigidBodyCollection)  parseRigidBodyCollection(child.RigidBodyCollection);
        }
    } else if (sceneData.RigidBodyCollection) {
        parseRigidBodyCollection(sceneData.RigidBodyCollection);
    }
}

function applyX3DTransform(group, tfData) {
    const t = tfData["@translation"] || [0, 0, 0];
    const c = tfData["@center"]      || [0, 0, 0];
    const r = tfData["@rotation"]    || [0, 0, 1, 0];
    const s = tfData["@scale"]       || [1, 1, 1];

    const T  = new THREE.Matrix4().makeTranslation(t[0], t[1], t[2]);
    const Tc = new THREE.Matrix4().makeTranslation( c[0],  c[1],  c[2]);
    const Tn = new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]);
    const R  = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(r[0], r[1], r[2]).normalize(), r[3]);
    const S  = new THREE.Matrix4().makeScale(s[0], s[1], s[2]);

    const M = new THREE.Matrix4();
    M.multiply(T).multiply(Tc).multiply(R).multiply(S).multiply(Tn);
    group.applyMatrix4(M);
}

function triangulateFaceSet(indices) {
    if (!indices.includes(-1)) {
        return Array.from(indices);
    }

    const tris = [];
    let face = [];
    for (let i = 0; i < indices.length; i++) {
        if (indices[i] === -1) {
            for (let j = 1; j < face.length - 1; j++) {
                tris.push(face[0], face[j], face[j+1]);
            }
            face = [];
        } else {
            face.push(indices[i]);
        }
    }
    if (face.length >= 3) {
        for (let j = 1; j < face.length - 1; j++) {
            tris.push(face[0], face[j], face[j+1]);
        }
    }
    return tris;
}

export async function loadX3DHumanoid(json, scene, parentGroup) {
    const x3dScene = json.X3D['-Scene'] || json.X3D.Scene;
    if (!x3dScene) return null;

    const childrenNodes = x3dScene['-children'] || [];
    let humanoidNode = null, timeSensor = null;
    const interpolators = [];

    for (const child of childrenNodes) {
        if (child.HAnimHumanoid) humanoidNode = child.HAnimHumanoid;
        if (child.TimeSensor) timeSensor = child.TimeSensor;
        if (child.PositionInterpolator || child.OrientationInterpolator) interpolators.push(child);
    }
    if (!humanoidNode) return null;

    const skinNode = resolveUSE(humanoidNode['-skin'][0].Shape);
    const geoNode = resolveUSE(skinNode['-geometry']);
    const rawGeo = geoNode.TriangleSet || geoNode.IndexedTriangleSet || geoNode.IndexedFaceSet;

    const coordNode = resolveUSE(rawGeo['-coord']?.Coordinate || rawGeo.Coordinate);
    const positions = coordNode['@point'];
    const uvs = rawGeo['-texCoord'] ? resolveUSE(rawGeo['-texCoord'].TextureCoordinate)['@point'] : null;
    const colors = rawGeo['-color'] ? resolveUSE(rawGeo['-color'].Color)['@color'] : null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    if (rawGeo['@coordIndex']) {
        geometry.setIndex(triangulateFaceSet(rawGeo['@coordIndex']));
    } else if (rawGeo['@index']) {
        geometry.setIndex(rawGeo['@index']);
    }

    geometry.computeVertexNormals();

    const appearance = resolveUSE(skinNode['-appearance']?.Appearance);
    const textureNode = resolveUSE(appearance?.['-texture']);
    let material;

    if (textureNode && textureNode.ImageTexture) {
        const textureUrl = textureNode.ImageTexture['@url'][0];
        let basePath = textureUrl.startsWith("data:") ? "" : window.location.href.split('/').slice(0,-1).join('/') + '/';
        const diffuseMap = new THREE.TextureLoader().load(basePath + textureUrl);
        diffuseMap.colorSpace = THREE.SRGBColorSpace;
        diffuseMap.flipY = false;
        material = new THREE.MeshStandardMaterial({ map: diffuseMap, vertexColors: !!colors });
    } else {
    	if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        material = new THREE.MeshStandardMaterial({ vertexColors: !!colors });
    }

    const skeletonNodes = humanoidNode['-skeleton'] || [];
    const bones = [], boneMap = {};
    const vertexCount = positions.length / 3;
    const skinIndices = new Array(vertexCount * 4).fill(0), skinWeights = new Array(vertexCount * 4).fill(0);
    const weightCounts = new Array(vertexCount).fill(0);

    let boneIndex = 0;
    function parseJoint(jointObj, parentBone, pivotParent) {
        const joint = jointObj.HAnimJoint;
        const pivot = new THREE.Group(), bone = new THREE.Bone();
        bone.name = joint['@name'] || joint['@DEF'];
        applyX3DTransform(pivot, joint);
        if (pivotParent) { pivotParent.add(pivot); scene.add(pivotParent); }

        if (joint['@translation']) bone.position.fromArray(joint['@translation']);
        if (joint['@center']) bone.position.fromArray(joint['@center']);
        if (joint['@rotation']) {
            const [x, y, z, angle] = joint['@rotation'];
            bone.quaternion.setFromAxisAngle(new THREE.Vector3(x, y, z), angle);
        }
        if (joint['@scale']) bone.scale.fromArray(joint['@scale']);

        bones.push(bone);
        boneMap[joint['@DEF'] || bone.name] = bone;
        if (parentBone) parentBone.add(bone);

        const indices = joint['@skinCoordIndex'] || [], weights = joint['@skinCoordWeight'] || [];
        for (let i = 0; i < indices.length; i++) {
            const vIdx = indices[i], w = weights[i], wc = weightCounts[vIdx];
            if (wc < 4) {
                skinIndices[vIdx * 4 + wc] = boneIndex;
                skinWeights[vIdx * 4 + wc] = w;
                weightCounts[vIdx] += 1;
            }
        }
        boneIndex++;
        (joint['-children'] || []).forEach(c => { if (c.HAnimJoint) parseJoint(c, bone, pivot); });
        return bone;
    }

    const rootBones = skeletonNodes.map(rootNode => parseJoint(rootNode, null, null));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

    const skeleton = new THREE.Skeleton(bones);
    const mesh = new THREE.SkinnedMesh(geometry, material);
    rootBones.forEach(b => mesh.add(b));

    // Apply the HAnimHumanoid's own transform (scale, translation, rotation) to the mesh.
    // This is the scale the user specifies on the HAnimHumanoid node (e.g. @scale [0.025,0.025,0.025]).
    // We apply it here so that bone positions are consistent with the geometry in object space.
    if (humanoidNode['@scale']) mesh.scale.fromArray(humanoidNode['@scale']);
    if (humanoidNode['@translation']) mesh.position.fromArray(humanoidNode['@translation']);
    if (humanoidNode['@rotation']) {
        const [rx, ry, rz, ra] = humanoidNode['@rotation'];
        mesh.quaternion.setFromAxisAngle(new THREE.Vector3(rx, ry, rz).normalize(), ra);
    }

    // Do NOT bind here — the caller (processInline) must parent the mesh into the scene
    // graph first so that updateWorldMatrix() captures the full parent-chain transform
    // (including any ancestor scale from the wrapping Transform node).  Binding early
    // would record identity as the bind matrix, causing parent scale to be applied
    // twice during skinning and producing the wrong visual size.
    mesh.userData.pendingSkeleton = skeleton;

    // Save these references so the SoftBody can steal the UV'd geometry and animate properly!
    skinNode._skinnedMesh = mesh;
    skinNode._geometry = geometry;

    // mesh is NOT added to the scene here — processInline handles parenting.

    const duration = timeSensor ? (timeSensor['@cycleInterval'] || 1) : 1;
    const tracks = [];

    // Normalize routes into a flat array of plain ROUTE objects.
    // X3D JSON can store them two ways:
    //   1. x3dScene['-ROUTE'] — array of bare objects { "@fromNode": ..., "@toNode": ... }
    //   2. x3dScene['-children'] items — objects like { "ROUTE": { "@fromNode": ..., "@toNode": ... } }
    const rawRoutes = [
        ...(x3dScene['-ROUTE'] || []),
        ...(x3dScene['-children'] || []).filter(c => c.ROUTE).map(c => c.ROUTE),
    ];
    // If an entry still has a .ROUTE wrapper (format 2 ended up in '-ROUTE'), unwrap it.
    const routes = rawRoutes.map(r => (r['@fromNode'] !== undefined ? r : (r.ROUTE || r)));

    for (const interpObj of interpolators) {
        const type = interpObj.PositionInterpolator ? 'PositionInterpolator' : 'OrientationInterpolator';
        const interp = interpObj[type];
        const route = routes.find(r => r['@fromNode'] === interp['@DEF'] && r['@fromField'] === 'value_changed');
        if (!route) continue;

        const targetBone = boneMap[route['@toNode']];
        if (!targetBone) continue;

        const times = interp['@key'].map(k => k * duration);
        if (type === 'PositionInterpolator') {
            tracks.push(new THREE.VectorKeyframeTrack(`${targetBone.name}.position`, times, interp['@keyValue']));
        } else {
            const aaValues = interp['@keyValue'], quatValues = [];
            for(let i = 0; i < aaValues.length; i += 4) {
                const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(aaValues[i], aaValues[i+1], aaValues[i+2]), aaValues[i+3]);
                quatValues.push(q.x, q.y, q.z, q.w);
            }
            tracks.push(new THREE.QuaternionKeyframeTrack(`${targetBone.name}.quaternion`, times, quatValues));
        }
    }

    let mixer = null;
    if (tracks.length > 0) {
        mixer = new THREE.AnimationMixer(mesh);
        mixer.clipAction(new THREE.AnimationClip('X3D_Action', duration, tracks)).play();
    }
    return { mesh, mixer };
}

async function processInline(inlineNode, parentGroup) {
    const urlArray = inlineNode['@url'];
    if (!urlArray || urlArray.length === 0) return;
    const url = urlArray[0];
    const inlineDef = inlineNode['@DEF'] || inlineNode['DEF'];

    const g = new THREE.Group();
    parentGroup.add(g);

    try {
        let inlineJson;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            inlineJson = await response.json();
        } catch (fetchErr) {
            console.warn(`Fetch failed for Inline ${url}, attempting dynamic import...`, fetchErr.message);
            const cleanUrl = url.startsWith('src/') ? url.substring(4) : url;
            const module = await import(/* @vite-ignore */ `./${cleanUrl}`);
            inlineJson = module.default || module;
        }

        scanForDefs(inlineJson);

        const localExports = scanForExports(inlineJson);
        if (inlineDef) {
            inlineExportsMap[inlineDef] = {};
            for (const exp of localExports) {
                const localName = exp["@localDEF"] || exp["localDEF"];
                const asName = exp["@AS"] || exp["AS"] || localName;
                if (globalDefMap[localName]) inlineExportsMap[inlineDef][asName] = globalDefMap[localName];
            }
        }

        if (inlineJson.X3D?.Scene) await parseSceneJSON(inlineJson.X3D.Scene, g);

        const humanoidResult = await loadX3DHumanoid(inlineJson, scene, g);
        if (humanoidResult) {
            if (humanoidResult.mesh) {
                humanoidResult.mesh.frustumCulled = false;
                g.add(humanoidResult.mesh);

                // Now that the mesh is inside the scene graph (and inherits any ancestor scale
                // from the wrapping Transform node), update all world matrices and THEN bind the
                // skeleton.  This ensures bindMatrix and the per-bone inverses are computed with
                // the full parent-chain transform so the skinning shader applies the scale exactly
                // once instead of doubling it.
                humanoidResult.mesh.updateWorldMatrix(true, true);
                humanoidResult.mesh.bind(humanoidResult.mesh.userData.pendingSkeleton);
            }
            if (humanoidResult.mixer) mixers.push(humanoidResult.mixer);
        }
    } catch (err) {
        console.error(`Failed to load Inline scene from ${url}:`, err);
    }
}

function processImport(importNode) {
    const inlineDef = importNode["@inlineDEF"] || importNode["inlineDEF"];
    const importedDef = importNode["@importedDEF"] || importNode["importedDEF"];
    const asName = importNode["@AS"] || importNode["AS"] || importedDef;

    if (inlineExportsMap[inlineDef] && inlineExportsMap[inlineDef][importedDef]) {
        globalDefMap[asName] = inlineExportsMap[inlineDef][importedDef];
    } else if (globalDefMap[importedDef]) {
        globalDefMap[asName] = globalDefMap[importedDef];
    }
}

async function parseTransformChildren(children, parentGroup) {
    if (!children) return;
    for (const child of children) {
        if (child.Shape) parseShapeNode(child.Shape, parentGroup);
        else if (child.Transform) {
            const g = new THREE.Group();
            applyX3DTransform(g, child.Transform);
            parentGroup.add(g);
            await parseTransformChildren(child.Transform["-children"], g);
        }
        else if (child.Group) {
            const g = new THREE.Group();
            parentGroup.add(g);
            await parseTransformChildren(child.Group["-children"], g);
        }
        else if (child.DirectionalLight) parseDirectionalLight(child.DirectionalLight);
        else if (child.PointLight)       parsePointLight(child.PointLight);
        else if (child.SpotLight)        parseSpotLight(child.SpotLight);
        else if (child.Inline)           await processInline(child.Inline, parentGroup);
        else if (child.IMPORT)           processImport(child.IMPORT);
    }
}

async function parseTransform(tfData, parentGroup) {
    const group = new THREE.Group();
    applyX3DTransform(group, tfData);
    await parseTransformChildren(tfData["-children"], group);
    parentGroup.add(group);
    return group;
}

function parseShapeNode(originalShapeData, parentGroup) {
    const shapeData = resolveUSE(originalShapeData);
    if (!shapeData) return;

    const geomNode = resolveUSE(shapeData["-geometry"]);
    const appNode  = resolveUSE(shapeData["-appearance"]?.Appearance);
    const matData  = resolveUSE(appNode?.["-material"]?.Material);

    const diffuse  = matData?.["@diffuseColor"] || [1, 1, 1];
    const opacity  = matData?.["@transparency"] !== undefined ? 1.0 - matData["@transparency"] : 1.0;

    const material = new THREE.MeshPhongMaterial({
        color: new THREE.Color(...diffuse),
        transparent: opacity < 1.0, opacity, side: THREE.DoubleSide,
    });

    const attach = (geo) => {
        if (!geo) return;
        if (geo instanceof THREE.Group) {
            geo.traverse(child => {
                if (child.isMesh) { child.material = material.clone(); child.castShadow = true; }
            });
            parentGroup.add(geo);
        } else {
            const mesh = new THREE.Mesh(geo, material);
            mesh.castShadow = true; mesh.receiveShadow = true;
            parentGroup.add(mesh);
        }
    };

    const result = parseX3DGeometry(geomNode);
    if (result instanceof Promise) result.then(attach);
    else attach(result);
}

function extractShapeNodes(geomArray) {
    if (!geomArray) return [];
    const shapes = [], arr = Array.isArray(geomArray) ? geomArray : [geomArray];

    arr.forEach(entry => {
        const cs = resolveUSE(entry.CollidableShape) || entry.CollidableShape;
        if (!cs) return;

        const csList = Array.isArray(cs) ? cs : [cs];
        csList.forEach(c => {
            const resolvedC = resolveUSE(c);
            const shapeNodeRef = resolvedC["-shape"] || resolvedC.shape || resolvedC;
            const shape = resolveUSE(shapeNodeRef.Shape || shapeNodeRef.shape);
            if (shape) shapes.push(shape);
        });
    });
    return shapes;
}

function parseX3DGeometry(originalGeomNode) {
    const geomNode = resolveUSE(originalGeomNode);
    if (!geomNode) return null;

    if (geomNode.Box) return new THREE.BoxGeometry(...(geomNode.Box["@size"] || [1,1,1]));
    if (geomNode.Sphere) return new THREE.SphereGeometry(geomNode.Sphere["@radius"] || 1, 32, 16);
    if (geomNode.Cylinder) return new THREE.CylinderGeometry(geomNode.Cylinder["@radius"] || 1, geomNode.Cylinder["@radius"] || 1, geomNode.Cylinder["@height"] || 2, 32);

    if (geomNode.IndexedFaceSet) {
        const ifs = geomNode.IndexedFaceSet;
        const coordNode = resolveUSE(ifs["-coord"]?.Coordinate || ifs.Coordinate);
        const coords = coordNode?.["@point"] || [];
        const indices = ifs["@coordIndex"] || [];

        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
        geom.setIndex(triangulateFaceSet(indices));
        geom.computeVertexNormals();
        return geom;
    }

    if (geomNode.ElevationGrid) {
        const eg = geomNode.ElevationGrid;
        const xDim = eg["@xDimension"], zDim = eg["@zDimension"];
        const geom = new THREE.PlaneGeometry(xDim * (eg["@xSpacing"] || 1), zDim * (eg["@zSpacing"] || 1), xDim - 1, zDim - 1);
        const heights = eg["@height"] || [], pos = geom.attributes.position;
        for (let i = 0; i < heights.length; i++) pos.setY(i, heights[i]);
        pos.needsUpdate = true;
        geom.computeVertexNormals();
        return geom;
    }

    if (geomNode.TriangleSet) {
        const coordNode = resolveUSE(geomNode.TriangleSet["-coord"]?.Coordinate || geomNode.TriangleSet.Coordinate);
        const pts = coordNode?.["@point"] || [];
        let geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        geo = BufferGeometryUtils.mergeVertices(geo);
        geo.computeVertexNormals();
        return geo;
    }

    if (geomNode.IndexedTriangleSet) {
        const index = geomNode.IndexedTriangleSet["@index"] || [];
        const coordNode = resolveUSE(geomNode.IndexedTriangleSet["-coord"]?.Coordinate || geomNode.IndexedTriangleSet.Coordinate);
        const pts = coordNode?.["@point"] || [];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        if (index.length) geo.setIndex(index);
        geo.computeVertexNormals();
        return geo;
    }

    return null;
}

function parseRigidBodyCollection(collection) {
    if (!collection) return;

    const gravity = collection["@gravity"] || [0, -9.8, 0];
    const gravVec = new Ammo.btVector3(gravity[0], gravity[1], gravity[2]);
    physicsWorld.setGravity(gravVec);                    // affects rigid bodies
    physicsWorld.getWorldInfo().set_m_gravity(gravVec);  // affects soft bodies (separate field in btSoftRigidDynamicsWorld)

    if (collection["-bodies"]) {
        collection["-bodies"].forEach(bodyNode => {
            const rb = resolveUSE(bodyNode.RigidBody);
            const sb = resolveUSE(bodyNode.SoftBody);

            if (rb) {
                const mass = rb["@mass"];
                const pos = rb["@position"] || [0, 0, 0];
                const ori = rb["@orientation"];
                const def = rb["@DEF"];
                const shapeNodes = extractShapeNodes(rb["-geometry"]);
                if (!shapeNodes.length) return;
                const appearance = resolveUSE(shapeNodes[0]?.["-appearance"]?.Appearance);
                const color = resolveUSE(appearance?.["-material"]?.Material)?.["@diffuseColor"] || [1, 1, 1];

                const scale = rb["@scale"];
                createCompoundRigidBody(def, shapeNodes, mass, pos, color, ori, scale);
            } else if (sb) {
                const shapeNodes = extractShapeNodes(sb["-geometry"]);
                if (!shapeNodes.length) return;

                const shapeNode = resolveUSE(shapeNodes[0]);
                const geomNode = resolveUSE(shapeNode["-geometry"]);
                const appearance = resolveUSE(shapeNode?.["-appearance"]?.Appearance);
                const col = resolveUSE(appearance?.["-material"]?.Material)?.["@diffuseColor"] || [0.8, 0.8, 0.8];

                if (!geomNode && !shapeNode._skinnedMesh) return;

                if (geomNode && geomNode.ElevationGrid) createSoftBodyCloth(sb, shapeNode, col);
                else if (geomNode && geomNode.Sphere) createSoftBodySphere(sb, shapeNode, col);
                else createSoftBodyFromGeometry(sb, shapeNode, col);
            }
        });
    }

    if (collection["-joints"]) {
        collection["-joints"].forEach(jointNode => {
            if (jointNode.SingleAxisHingeJoint) createHinge(jointNode.SingleAxisHingeJoint);
            else if (jointNode.Stitch) createStitch(jointNode.Stitch);
        });
    }
}

function createCompoundRigidBody(def, shapeNodes, mass, pos, colorArray, ori, scale) {
    const defaultMaterial = new THREE.MeshPhongMaterial({ color: new THREE.Color(...colorArray) });

    const parent = new THREE.Object3D();
    parent.position.set(pos[0], pos[1], pos[2]);
    if (ori) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
        parent.quaternion.copy(q);
    }
    scene.add(parent);

    const compound = new Ammo.btCompoundShape();
    const localInertia = new Ammo.btVector3(0, 0, 0);

    shapeNodes.forEach(shapeNode => {
        if (shapeNode._skinnedMesh && shapeNode._geometry) {
            // === Humanoid skin path ===
            // Re-parent the already-animated SkinnedMesh (created by loadX3DHumanoid) onto
            // the physics body's Object3D so it:
            //   (a) moves/rotates with the rigid-body simulation, AND
            //   (b) continues to play its bone animation via the existing AnimationMixer.
            // Three.js parent.add() automatically detaches the mesh from processInline's group.
            const skinnedMesh = shapeNode._skinnedMesh;
            parent.updateMatrixWorld(true);
            parent.add(skinnedMesh);
            skinnedMesh.position.set(0, 0, 0); // physics parent drives world position
            skinnedMesh.updateWorldMatrix(true, true);
            // Rebind the skeleton under the new parent so bindMatrix (and the per-bone
            // inverses) are recomputed from the correct world matrix.  Without this the
            // skinning shader applies the old bind pose and the mesh deforms incorrectly.
            skinnedMesh.bind(skinnedMesh.skeleton);
            skinnedMesh.castShadow = true;
            skinnedMesh.receiveShadow = true;
            skinnedMesh.frustumCulled = false;

            // Clone geometry purely for Bullet bounding-box / collision-shape computation;
            // it is NOT used as a visible mesh.
            const geom = shapeNode._geometry.clone();
            if (scale) geom.scale(scale[0], scale[1], scale[2]);
            geom.computeBoundingBox();
            const bb = geom.boundingBox;
            const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
            const cx = (bb.min.x + bb.max.x) * 0.5, cy = (bb.min.y + bb.max.y) * 0.5, cz = (bb.min.z + bb.max.z) * 0.5;

            const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
            shape.setMargin(margin);
            const childTransform = new Ammo.btTransform();
            childTransform.setIdentity();
            childTransform.setOrigin(new Ammo.btVector3(cx, cy, cz));
            compound.addChildShape(childTransform, shape);
            Ammo.destroy(childTransform);

        } else {
            // === Standard (non-humanoid) shape path ===
            const geomNode = resolveUSE(shapeNode["-geometry"]);
            const geometry = parseX3DGeometry(geomNode);
            if (!geometry) return;

            // Apply body-level @scale before the bounding box so the Bullet collision
            // shape matches the visual size.
            if (scale) geometry.scale(scale[0], scale[1], scale[2]);

            geometry.computeBoundingBox();
            const bb = geometry.boundingBox;
            const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
            const cx = (bb.min.x + bb.max.x) * 0.5, cy = (bb.min.y + bb.max.y) * 0.5, cz = (bb.min.z + bb.max.z) * 0.5;

            const mesh = new THREE.Mesh(geometry, defaultMaterial);
            mesh.castShadow = true; mesh.receiveShadow = true;
            mesh.position.set(cx, cy, cz);
            parent.add(mesh);

            const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
            shape.setMargin(margin);
            const childTransform = new Ammo.btTransform();
            childTransform.setIdentity();
            childTransform.setOrigin(new Ammo.btVector3(cx, cy, cz));
            compound.addChildShape(childTransform, shape);
            Ammo.destroy(childTransform);
        }
    });

    compound.calculateLocalInertia(mass, localInertia);

    const startTransform = new Ammo.btTransform();
    startTransform.setIdentity();
    startTransform.setOrigin(new Ammo.btVector3(pos[0], pos[1], pos[2]));

    if (ori) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
        const btQuat = new Ammo.btQuaternion(q.x, q.y, q.z, q.w);
        startTransform.setRotation(btQuat);
        Ammo.destroy(btQuat);
    }

    const motionState = new Ammo.btDefaultMotionState(startTransform);
    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, compound, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    parent.userData.physicsBody = body;

    if (mass > 0) {
        rigidBodies.push(parent);
        body.setActivationState(4);
    }

    physicsWorld.addRigidBody(body, 2, -1);
    if (def) parsedBodiesMap[def] = { mesh: parent, body };
}

function createSoftBodyFromGeometry(sbConfig, shapeNode, colorArray) {
    const mass = sbConfig["@mass"] || 1;
    let geometry;
    let material;
    let isHumanoid = !!shapeNode._skinnedMesh;

    if (isHumanoid) {
        // Clone the humanoid skin geometry (preserves UVs perfectly).
        geometry = shapeNode._geometry.clone();

        // Bake the full world transform (including the wrapping Transform's @scale)
        // into the vertex positions so the soft-body nodes start at the correct
        // world-space location and size.
        shapeNode._skinnedMesh.updateMatrixWorld(true);
        geometry.applyMatrix4(shapeNode._skinnedMesh.matrixWorld);

        material = shapeNode._skinnedMesh.material.clone();

        // Hide the SkinnedMesh — the soft body IS the visible Gramps.
        // Track it so the AnimationMixer keeps advancing bone world-matrices every
        // frame; those are read back for the COM-relative pose driving loop.
        shapeNode._skinnedMesh.visible = false;
        hiddenSkinnedMeshes.push(shapeNode._skinnedMesh);
    } else {
        const geomNode = resolveUSE(shapeNode["-geometry"]);
        geometry = parseX3DGeometry(geomNode);
        if (!geometry || !geometry.attributes.position) return;

        geometry.computeVertexNormals();

        const scale = sbConfig["@scale"] || [1, 1, 1];
        geometry.scale(scale[0], scale[1], scale[2]);

        const ori = sbConfig["@orientation"];
        if (ori) {
            const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
            geometry.applyQuaternion(q);
        }

        const pos = sbConfig["@position"] || [0,0,0];
        geometry.translate(pos[0], pos[1], pos[2]);

        material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray), side: THREE.DoubleSide });
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    scene.add(mesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();

    // Full-res render vertex array — used only for building the node→vert mapping.
    const vertices = geometry.attributes.position.array;

    // --- Build a low-poly physics proxy ---
    // CreateFromTriMesh allocates O(n²) constraint memory; 500k+ verts → OOM.
    // Decimate to ≤ MAX_PHYSICS_VERTS for simulation; the full render mesh is
    // mapped back to the nearest soft-body node every frame for visuals.
    const MAX_PHYSICS_VERTS = 1200;
    let physicsGeometry = geometry.clone();
    for (const attrName of Object.keys(physicsGeometry.attributes)) {
        if (attrName !== 'position') physicsGeometry.deleteAttribute(attrName);
    }
    physicsGeometry = BufferGeometryUtils.mergeVertices(physicsGeometry, 1e-4);
    if (physicsGeometry.attributes.position.count > MAX_PHYSICS_VERTS) {
        try {
            const modifier = new SimplifyModifier();
            physicsGeometry = modifier.modify(
                physicsGeometry,
                physicsGeometry.attributes.position.count - MAX_PHYSICS_VERTS
            );
        } catch (e) {
            console.warn('SimplifyModifier failed, using merged-only proxy:', e);
        }
    }
    console.log(`SoftBody proxy: ${physicsGeometry.attributes.position.count} verts (render mesh: ${Math.round(vertices.length / 3)})`);

    const physVerts = physicsGeometry.attributes.position.array;
    const physIdx   = physicsGeometry.index
        ? physicsGeometry.index.array
        : new Uint16Array(physVerts.length / 3).map((_, i) => i);

    if (physVerts.length === 0 || physIdx.length === 0) return;

    const numTriangles = Math.floor(physIdx.length / 3);
    const vArray = Array.from(physVerts);
    const iArray = Array.from(physIdx);

    const triMeshSoftBody = softBodyHelpers.CreateFromTriMesh(
        physicsWorld.getWorldInfo(), vArray, iArray, numTriangles, true
    );

    // --- Jelly Physics Properties ---
    const sbCfg = triMeshSoftBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    sbCfg.set_kDF(0.5);   // Dynamic friction
    sbCfg.set_kDP(0.005); // Very low damping — preserves bounce and jiggle
    // kPR (pressure) only works for sealed balloon volumes; a humanoid skin has
    // open seams so it either does nothing or explodes the body. kMT (pose-matching)
    // is the correct parameter: it gives nodes a memory of their rest shape so the
    // body jiggles back like a jelly mould after being deformed.
    sbCfg.set_kMT(0.3);
    // SDF_RS (0x01) = soft vs rigid collision via SDF.
    // CL_SS  (0x10) = cluster vs cluster soft-soft collision.
    sbCfg.set_collisions(0x11);

    const sbMat = triMeshSoftBody.get_m_materials().at(0);
    sbMat.set_m_kLST(0.2); // Linear stiffness  — low = soft/elastic
    sbMat.set_m_kAST(0.2); // Angular stiffness
    sbMat.set_m_kVST(0.2); // Volume stiffness

    triMeshSoftBody.setTotalMass(mass, false);
    triMeshSoftBody.generateBendingConstraints(2, sbMat);
    // NOTE: setPose is not bound in this Ammo.js build — shape memory is provided
    // by kMT (pose-matching stiffness) together with the per-frame driving loop.

    Ammo.castObject(triMeshSoftBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin);
    physicsWorld.addSoftBody(triMeshSoftBody, 1, -1);
    triMeshSoftBody.setActivationState(4);

    const nodes = triMeshSoftBody.get_m_nodes();
    const mapping = [];
    for (let i = 0; i < vertices.length / 3; i++) {
        let vx = vertices[i * 3], vy = vertices[i * 3 + 1], vz = vertices[i * 3 + 2];
        let minDist = Infinity, minIdx = -1;
        for (let j = 0; j < nodes.size(); j++) {
            const nodePos = nodes.at(j).get_m_x();
            const dx = vx - nodePos.x(), dy = vy - nodePos.y(), dz = vz - nodePos.z();
            const dist = dx*dx + dy*dy + dz*dz;
            if (dist < minDist) { minDist = dist; minIdx = j; }
        }
        mapping.push(minIdx);
    }

    mesh.userData.physicsBody = triMeshSoftBody;
    mesh.userData.isGenericSoft = true;
    mesh.userData.mapping = mapping;

    if (isHumanoid) {
        mesh.userData.isAnimatedJelly = true;
        mesh.userData.skinnedMesh = shapeNode._skinnedMesh;
        // reverseMapping[nodeIndex] = a representative render-vertex index.
        // Used by the COM-relative driving loop to CPU-skin each node's
        // animated target position from the hidden SkinnedMesh.
        const reverseMapping = new Int32Array(nodes.size()).fill(-1);
        for (let i = 0; i < mapping.length; i++) {
            if (reverseMapping[mapping[i]] === -1) reverseMapping[mapping[i]] = i;
        }
        mesh.userData.reverseMapping = reverseMapping;
    }

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh, body: triMeshSoftBody, isSoft: true };
    softBodies.push(mesh);
}

function createSoftBodyCloth(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"] || [0,0,0];
    const ori = sbConfig["@orientation"];
    const mass = sbConfig["@mass"] || 1;

    const grid = resolveUSE(shapeNode?.["-geometry"])?.ElevationGrid;
    const xDim = grid?.["@xDimension"] || 36;
    const zDim = grid?.["@zDimension"] || 26;
    const xSpacing = grid?.["@xSpacing"] || 0.2;
    const zSpacing = grid?.["@zSpacing"] || 0.2;

    const segZ = xDim - 1, segY = zDim - 1, width = segZ * xSpacing, height = segY * zSpacing;

    const geometry = new THREE.PlaneGeometry(width, height, segZ, segY);
    geometry.rotateY(Math.PI * 0.5);

    if (ori) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
        geometry.applyQuaternion(q);
    }

    geometry.translate(pos[0], pos[1] + height * 0.5, pos[2] - width * 0.5);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray), side: THREE.DoubleSide });
    const clothMesh = new THREE.Mesh(geometry, material);
    clothMesh.castShadow = true; clothMesh.receiveShadow = true; clothMesh.frustumCulled = false;
    scene.add(clothMesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();

    const posArray = geometry.attributes.position.array;
    const getVert = (idx) => new Ammo.btVector3(posArray[idx*3], posArray[idx*3+1], posArray[idx*3+2]);

    const corner00 = getVert(0);
    const corner01 = getVert(segZ);
    const corner10 = getVert(segY * (segZ + 1));
    const corner11 = getVert((segY + 1) * (segZ + 1) - 1);

    const clothSoftBody = softBodyHelpers.CreatePatch(physicsWorld.getWorldInfo(), corner00, corner01, corner10, corner11, segZ + 1, segY + 1, 0, true);

    const sbCfg = clothSoftBody.get_m_cfg();
    sbCfg.set_viterations(10); sbCfg.set_piterations(10);
    clothSoftBody.setTotalMass(mass, false);
    Ammo.castObject(clothSoftBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin * 3);

    physicsWorld.addSoftBody(clothSoftBody, 1, -1);
    clothMesh.userData.physicsBody = clothSoftBody;
    clothMesh.userData.isCloth = true;
    clothSoftBody.setActivationState(4);

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh: clothMesh, body: clothSoftBody, isSoft: true };
    softBodies.push(clothMesh);
}

function createSoftBodySphere(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"] || [0,0,0];
    const ori = sbConfig["@orientation"];
    const mass = sbConfig["@mass"] || 1;

    const sphere = resolveUSE(shapeNode?.["-geometry"])?.Sphere;
    const radius = sphere?.["@radius"] || 1.0;

    const geometry = new THREE.SphereGeometry(radius, 32, 16);

    if (ori) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
        geometry.applyQuaternion(q);
    }

    geometry.translate(pos[0], pos[1], pos[2]);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    scene.add(mesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const center = new Ammo.btVector3(0, 0, 0);
    const radiusVec = new Ammo.btVector3(radius, radius, radius);

    const softBody = softBodyHelpers.CreateEllipsoid(physicsWorld.getWorldInfo(), center, radiusVec, 256);

    const tr = new Ammo.btTransform();
    tr.setIdentity();
    if (ori) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(ori[0], ori[1], ori[2]).normalize(), ori[3]);
        const btQuat = new Ammo.btQuaternion(q.x, q.y, q.z, q.w);
        tr.setRotation(btQuat);
        Ammo.destroy(btQuat);
    }
    const btPos = new Ammo.btVector3(pos[0], pos[1], pos[2]);
    tr.setOrigin(btPos);
    softBody.transform(tr);

    const sbCfg = softBody.get_m_cfg();
    sbCfg.set_viterations(10); sbCfg.set_piterations(10); sbCfg.set_kDF(0.1); sbCfg.set_kDP(0.01); sbCfg.set_kPR(10);

    const sbMat = softBody.get_m_materials().at(0);
    sbMat.set_m_kLST(0.15); sbMat.set_m_kAST(0.1); sbMat.set_m_kVST(0.1);

    softBody.setTotalMass(mass, false);
    Ammo.castObject(softBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin);

    softBody.generateBendingConstraints(2, sbMat);
    physicsWorld.addSoftBody(softBody, 1, -1);

    mesh.userData.physicsBody = softBody;
    mesh.userData.isSphere = true;
    softBody.setActivationState(4);

    const nodes = softBody.get_m_nodes();
    const mapping = [];
    const positions = geometry.attributes.position.array;

    for (let i = 0; i < positions.length / 3; i++) {
        let vx = positions[i * 3], vy = positions[i * 3 + 1], vz = positions[i * 3 + 2];
        let minDist = Infinity, minIdx = -1;
        for (let j = 0; j < nodes.size(); j++) {
            let nodePos = nodes.at(j).get_m_x();
            let dx = vx - nodePos.x(), dy = vy - nodePos.y(), dz = vz - nodePos.z();
            let dist = dx * dx + dy * dy + dz * dz;
            if (dist < minDist) { minDist = dist; minIdx = j; }
        }
        mapping.push(minIdx);
    }
    mesh.userData.mapping = mapping;

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh, body: softBody, isSoft: true };

    Ammo.destroy(center); Ammo.destroy(radiusVec); Ammo.destroy(tr); Ammo.destroy(btPos);
    softBodies.push(mesh);
}

function createHinge(jointConfig) {
    const b1Name = jointConfig["-body1"]?.RigidBody?.["@USE"] || jointConfig["@body1"];
    const b2Name = jointConfig["-body2"]?.RigidBody?.["@USE"] || jointConfig["@body2"];

    const b1 = parsedBodiesMap[b1Name];
    const b2 = parsedBodiesMap[b2Name];
    const ap = jointConfig["@anchorPoint"];
    const ax = jointConfig["@axis"];

    if (!b1 || !b2) return;

    const pA = new Ammo.btVector3(ap[0] - b1.mesh.position.x, ap[1] - b1.mesh.position.y, ap[2] - b1.mesh.position.z);
    const pB = new Ammo.btVector3(ap[0] - b2.mesh.position.x, ap[1] - b2.mesh.position.y, ap[2] - b2.mesh.position.z);
    const axis = new Ammo.btVector3(ax[0], ax[1], ax[2]);

    globalHinge = new Ammo.btHingeConstraint(b1.body, b2.body, pA, pB, axis, axis, true);
    physicsWorld.addConstraint(globalHinge, true);
}

function createStitch(stitchConfig) {
    const rbName = stitchConfig["-body1"]?.RigidBody?.["@USE"] || stitchConfig["@body1"];
    const sbName = stitchConfig["-body2"]?.SoftBody?.["@USE"] || stitchConfig["@body2"];

    const rbEntry = parsedBodiesMap[rbName];
    const sbEntry = parsedBodiesMap[sbName];

    if (!rbEntry || !sbEntry) return;

    const indices = (stitchConfig["@body1Index"] || []).map(Number);
    const weights = (stitchConfig["@weight"] || []).map(Number);

    const softBody = sbEntry.body;
    indices.forEach((nodeIndex, i) => {
        const weight = weights[i] !== undefined ? weights[i] : 1.0;
        softBody.appendAnchor(nodeIndex, rbEntry.body, false, weight);
    });
}

function parseBackground(bgData) {
    const color = bgData["@skyColor"] || [0, 0, 0];
    scene.background = new THREE.Color(color[0], color[1], color[2]);
}

function parseViewpoint(vpData) {
    if (vpData["@position"]) {
        const pos = vpData["@position"];
        camera.position.set(pos[0], pos[1], pos[2]);
    }
    if (vpData["@fieldOfView"]) {
        camera.fov = vpData["@fieldOfView"] * (180 / Math.PI);
        camera.updateProjectionMatrix();
    }
    if (vpData["@centerOfRotation"]) {
        const cor = vpData["@centerOfRotation"];
        if (cor) {
            camera.lookAt(cor[0], cor[1], cor[2]);
            if (controls) controls.target.set(cor[0], cor[1], cor[2]);
        }
        if (controls) controls.update();
    }
}

function parseEnvironmentLight(elData) {
    const color = elData["@color"] || [1, 1, 1];
    const intensity = elData["@ambientIntensity"] !== undefined ? elData["@ambientIntensity"] : 1.0;
    const ambientLight = new THREE.AmbientLight(new THREE.Color(color[0], color[1], color[2]), intensity);
    scene.add(ambientLight);
}

function parseDirectionalLight(dlData) {
    const color = dlData["@color"] || [1, 1, 1];
    const intensity = dlData["@intensity"] !== undefined ? dlData["@intensity"] : 1.0;
    const dir = dlData["@direction"] || [0, 0, -1];

    const light = new THREE.DirectionalLight(new THREE.Color(color[0], color[1], color[2]), intensity);

    const dist = 15;
    light.position.set(-dir[0] * dist, -dir[1] * dist, -dir[2] * dist);
    light.castShadow = true;
    light.shadow.camera.left = -dist; light.shadow.camera.right = dist;
    light.shadow.camera.top = dist; light.shadow.camera.bottom = -dist;

    scene.add(light);
}

function parsePointLight(plData) {
    const color = plData["@color"] || [1, 1, 1];
    const intensity = plData["@intensity"] !== undefined ? plData["@intensity"] : 1.0;
    const loc = plData["@location"] || [0, 0, 0];
    const radius = plData["@radius"] || 100;

    const light = new THREE.PointLight(new THREE.Color(color[0], color[1], color[2]), intensity, radius);
    light.position.set(loc[0], loc[1], loc[2]);
    light.castShadow = true;
    scene.add(light);
}

function parseSpotLight(slData) {
    const color = slData["@color"] || [1, 1, 1];
    const intensity = slData["@intensity"] !== undefined ? slData["@intensity"] : 1.0;
    const loc = slData["@location"] || [0, 0, 0];
    const dir = slData["@direction"] || [0, 0, -1];
    const cutOffAngle = slData["@cutOffAngle"] || (Math.PI / 4);
    const radius = slData["@radius"] || 100;

    const light = new THREE.SpotLight(new THREE.Color(color[0], color[1], color[2]), intensity, radius, cutOffAngle);
    light.position.set(loc[0], loc[1], loc[2]);

    const target = new THREE.Object3D();
    target.position.set(loc[0] + dir[0], loc[1] + dir[1], loc[2] + dir[2]);
    scene.add(target);
    light.target = target;
    light.castShadow = true;
    scene.add(light);
}

function initInput() {
    window.addEventListener('keydown', (e) => {
        if (e.keyCode === 81) armMovement = 1;
        if (e.keyCode === 65) armMovement = -1;
    }, false);
    window.addEventListener('keyup', () => armMovement = 0, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    timer.update();
    const deltaTime = Math.min(timer.getDelta(), 0.05);

    mixers.forEach(mixer => mixer.update(deltaTime));

    // Force hidden meshes (the original SkinnedMesh) to update their world matrices!
    // This allows our physics Kinematic bones below to read the actual moving bone locations.
    hiddenSkinnedMeshes.forEach(mesh => mesh.updateMatrixWorld(true));

    kinematicBones.forEach(({ bone, body }) => {
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        bone.getWorldPosition(pos);
        bone.getWorldQuaternion(quat);

        transformAux1.setIdentity();
        transformAux1.setOrigin(new Ammo.btVector3(pos.x, pos.y, pos.z));
        transformAux1.setRotation(new Ammo.btQuaternion(quat.x, quat.y, quat.z, quat.w));

        // Setting both ensures the Kinematic Body actively drives physics interactions and anchors
        const ms = body.getMotionState();
        if (ms) ms.setWorldTransform(transformAux1);
        body.setWorldTransform(transformAux1);
    });

    if (globalHinge) globalHinge.enableAngularMotor(true, 0.8 * armMovement, 50);

    // --- COM-relative animated-jelly pose driving ---
    //
    // THE PROBLEM with driving absolute world positions (blendFactor * (animTarget - nodePos)):
    //   Gravity adds ~0.16 m/s downward per frame. Even blendFactor=0.5 corrects
    //   0.5 * distance upward — for a node only 3 cm below its target that is
    //   0.015 m/s, already comparable to gravity. At blendFactor=6 used previously,
    //   the spring completely overwhelms gravity and Gramps is pinned in place.
    //
    // THE FIX — decouple global translation from pose animation:
    //   1. Compute the physics body's current center-of-mass (physicsCOM).
    //   2. Compute the animated center-of-mass (animCOM) from the skeleton.
    //   3. For each node, the spring target is:
    //        physicsCOM + (animatedNodePos - animCOM)
    //      i.e. the animated *offset from COM*, applied to wherever physics
    //      has moved the body.
    //   4. Apply a gentle spring impulse toward that relative target.
    //
    // Result: gravity and collisions move the whole body freely (physicsCOM falls
    // under gravity, bounces off objects). The spring only shapes the limbs around
    // that freely-moving centre — Gramps animates while truly obeying physics.

    softBodies.forEach(mesh => {
        if (!mesh.userData.isAnimatedJelly) return;

        const softBody    = mesh.userData.physicsBody;
        const nodes       = softBody.get_m_nodes();
        const nodeCount   = nodes.size();
        const skinnedMesh = mesh.userData.skinnedMesh;
        const revMap      = mesh.userData.reverseMapping;
        const skeleton    = skinnedMesh.skeleton;
        const geo         = skinnedMesh.geometry;
        const posAttr     = geo.attributes.position;
        const skinIdx     = geo.attributes.skinIndex;
        const skinWt      = geo.attributes.skinWeight;

        // Gentle pose-shape spring — strong enough to keep limbs recognisable,
        // weak enough that gravity (9.8 m/s²) easily moves the whole body.
        const poseFactor = 2.5;

        // Pre-compute per-bone skinning matrices (boneWorld × boneInverse) once per frame.
        const boneMats = skeleton.bones.map((bone, bi) =>
            _jellyMat.clone().multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[bi])
        );

        // --- Step 1: compute animated targets for every node and their COM ---
        const animTargets = [];
        _animCOM.set(0, 0, 0);
        for (let ni = 0; ni < nodeCount; ni++) {
            const vi = revMap[ni];
            _jellyTarget.set(0, 0, 0);
            if (vi !== -1) {
                const bx = posAttr.getX(vi), by = posAttr.getY(vi), bz = posAttr.getZ(vi);
                for (let j = 0; j < 4; j++) {
                    const w = skinWt.getComponent(vi, j);
                    if (w === 0) continue;
                    _jellyVec.set(bx, by, bz).applyMatrix4(boneMats[skinIdx.getComponent(vi, j)]);
                    _jellyTarget.addScaledVector(_jellyVec, w);
                }
                // Bring into world space via the hidden SkinnedMesh's matrixWorld.
                _jellyTarget.applyMatrix4(skinnedMesh.matrixWorld);
            }
            animTargets.push(_jellyTarget.clone());
            _animCOM.add(_jellyTarget);
        }
        _animCOM.divideScalar(nodeCount);

        // --- Step 2: compute physics body's current center-of-mass ---
        _physicsCOM.set(0, 0, 0);
        for (let ni = 0; ni < nodeCount; ni++) {
            const p = nodes.at(ni).get_m_x();
            _physicsCOM.x += p.x();
            _physicsCOM.y += p.y();
            _physicsCOM.z += p.z();
        }
        _physicsCOM.divideScalar(nodeCount);

        // --- Step 3: apply COM-relative spring impulse to each node ---
        // Target = physicsCOM + (animatedOffset from animCOM).
        // This corrects limb shape around wherever gravity has moved the body.
        for (let ni = 0; ni < nodeCount; ni++) {
            const animOffset = animTargets[ni].sub(_animCOM); // offset in animated space
            const tx = _physicsCOM.x + animOffset.x;
            const ty = _physicsCOM.y + animOffset.y;
            const tz = _physicsCOM.z + animOffset.z;

            const node = nodes.at(ni);
            const pos  = node.get_m_x();
            const vel  = node.get_m_v();
            vel.setValue(
                vel.x() + (tx - pos.x()) * poseFactor,
                vel.y() + (ty - pos.y()) * poseFactor,
                vel.z() + (tz - pos.z()) * poseFactor
            );
        }
    });

    physicsWorld.stepSimulation(deltaTime, 10);

    softBodies.forEach(mesh => {
        const softBody = mesh.userData.physicsBody;
        const nodes = softBody.get_m_nodes();

        if (mesh.userData.isSphere || mesh.userData.isGenericSoft) {
            const mapping = mesh.userData.mapping;
            const positions = mesh.geometry.attributes.position.array;
            for (let i = 0; i < mapping.length; i++) {
                const nodePos = nodes.at(mapping[i]).get_m_x();
                positions[i * 3]     = nodePos.x();
                positions[i * 3 + 1] = nodePos.y();
                positions[i * 3 + 2] = nodePos.z();
            }
            mesh.geometry.computeVertexNormals();
            mesh.geometry.attributes.position.needsUpdate = true;
            mesh.geometry.attributes.normal.needsUpdate = true;
        } else if (mesh.userData.isCloth || mesh.userData.isRope) {
            const positions = mesh.geometry.attributes.position.array;
            let idx = 0;
            for (let i = 0; i < positions.length / 3; i++) {
                const nodePos = nodes.at(i).get_m_x();
                positions[idx++] = nodePos.x(); positions[idx++] = nodePos.y(); positions[idx++] = nodePos.z();
            }
            if (mesh.userData.isCloth) mesh.geometry.computeVertexNormals();
            mesh.geometry.attributes.position.needsUpdate = true;
            if (mesh.userData.isCloth) mesh.geometry.attributes.normal.needsUpdate = true;
        }
    });

    rigidBodies.forEach(obj => {
        const ms = obj.userData.physicsBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(transformAux1);
            const p = transformAux1.getOrigin(), q = transformAux1.getRotation();
            obj.position.set(p.x(), p.y(), p.z());
            obj.quaternion.set(q.x(), q.y(), q.z(), q.w());
        }
    });

    if (controls) controls.update();
    renderer.render(scene, camera);
}
