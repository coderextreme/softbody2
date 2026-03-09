// import * as THREE from 'three';
// import { WebGPURenderer } from 'three/webgpu';
// import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// import WebGPU from 'three/addons/capabilities/WebGPU.js';
//import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
//import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';

let physicsWorld, scene, camera, renderer, controls;
let clock = new THREE.Clock();
let rigidBodies = [];
let softBodies = [];
let parsedBodiesMap = {};
let globalHinge = null;
let armMovement = 0;
const margin = 0.05;

let transformAux1;

// X3D FontStyle.family → typeface JSON file mapping
const fontMap = {
  'SERIF':      'fonts/gentilis_regular.typeface.json',
  'SANS':       'fonts/helvetiker_regular.typeface.json',
  'TYPEWRITER': 'fonts/droid/droid_sans_mono_regular.typeface.json',
};

// X3D FontStyle.style → font variant file suffix
const styleMap = {
  'PLAIN':      'regular',
  'BOLD':       'bold',
  'ITALIC':     'italic',
  'BOLDITALIC': 'bold', // Three.js fonts don't always have bold+italic
};

// Ensure the page is fully parsed before executing
window.addEventListener('load', () => {

    if (typeof Ammo === 'undefined') {
        document.getElementById('container').innerHTML = "<br><br><br><b>Error:</b> Ammo.js failed to load from the CDN. Please check your network/adblocker.";
        console.error("Ammo.js is undefined. The CDN script tag failed to execute.");
        return;
    }

    // Initialize Ammo.js
    Ammo().then((AmmoLib) => {
        window.Ammo = AmmoLib;
        transformAux1 = new Ammo.btTransform();

        initGraphics();
        initPhysics();
        initInput();

        // Fetch X3D JSON and parse it
        fetch('scene.json')
            .then(response => {
                if (!response.ok) throw new Error("Could not load scene.json");
                return response.json();
            })
            .then(json => {
                parseSceneJSON(json.X3D.Scene);
                animate();
            })
            .catch(err => console.error("Error loading scene.json:", err));
    });
});

function initGraphics() {
    const container = document.getElementById('container');
    container.innerHTML = ""; // Clear loading messages

    // Provide default camera; will be updated by Viewpoint in X3D
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 2000);

    scene = new THREE.Scene();

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);

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

function parseSceneJSON(sceneData) {
    const children = sceneData["-children"];

    if (children) {
        children.forEach(child => {
            if (child.Background) parseBackground(child.Background);
            if (child.Viewpoint) parseViewpoint(child.Viewpoint);
            if (child.EnvironmentLight) parseEnvironmentLight(child.EnvironmentLight);
            if (child.DirectionalLight) parseDirectionalLight(child.DirectionalLight);
            if (child.PointLight) parsePointLight(child.PointLight);
            if (child.SpotLight) parseSpotLight(child.SpotLight);
            if (child.RigidBodyCollection) parseRigidBodyCollection(child.RigidBodyCollection);
        });
    } else if (sceneData.RigidBodyCollection) {
        // Fallback for previous structure
        parseRigidBodyCollection(sceneData.RigidBodyCollection);
    }
}

function extractShapeNodes(geomArray) {
    if (!geomArray) return [];

    const shapes = [];

    const arr = Array.isArray(geomArray) ? geomArray : [geomArray];

    arr.forEach(entry => {
        const cs = entry.CollidableShape;
        if (!cs) return;

        const csList = Array.isArray(cs) ? cs : [cs];

        csList.forEach(c => {
            const shape = c["-shape"]?.Shape;
            if (shape) shapes.push(shape);
        });
    });

    return shapes;
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
        // Convert radians to degrees
        camera.fov = vpData["@fieldOfView"] * (180 / Math.PI);
        camera.updateProjectionMatrix();
    }
    if (vpData["@centerOfRotation"]) {
        const cor = vpData["@centerOfRotation"];
        controls.target.set(cor[0], cor[1], cor[2]);
        controls.update();
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

    // In Three.js, directional lights cast towards target (default origin).
    // We scale position back along the negative vector to match X3D direction.
    const dist = 15;
    light.position.set(-dir[0] * dist, -dir[1] * dist, -dir[2] * dist);

    // Shadow mapping defaults for this scene scale
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

    // Spotlights in ThreeJS require a target Object3D
    const target = new THREE.Object3D();
    target.position.set(loc[0] + dir[0], loc[1] + dir[1], loc[2] + dir[2]);
    scene.add(target);
    light.target = target;

    light.castShadow = true;
    scene.add(light);
}

// X3D: { "NurbsSurface": {
//   "@uOrder": 3, "@vOrder": 3,
//   "@uDimension": 4, "@vDimension": 4,
//   "@uKnot": [...], "@vKnot": [...],
//   "-controlPoint": { "Coordinate": { "@point": [...] } }
// }}
function x3dNurbsSurfaceToThree(node) {
  const uOrder = node["@uOrder"] !== undefined ? node["@uOrder"] : 3;
  const vOrder = node["@vOrder"] !== undefined ? node["@vOrder"] : 3;
  const uDimension = node["@uDimension"] || 0;
  const vDimension = node["@vDimension"] || 0;
  const uKnot = node["@uKnot"] || [];
  const vKnot = node["@vKnot"] || [];

  const coordNode = node["-controlPoint"]?.Coordinate || node["-coord"]?.Coordinate || node.Coordinate;
  const pts = coordNode?.["@point"] || [];
  const ctrlPts = [];
  for (let i = 0; i < pts.length; i += 3) {
      ctrlPts.push(new THREE.Vector4(pts[i], pts[i + 1], pts[i + 2], 1.0));
  }

  const surface = new NURBSSurface(
    uOrder - 1, vOrder - 1, uKnot, vKnot,
    // Reshape flat array into [uDimension][vDimension] grid
    Array.from({ length: uDimension }, (_, i) =>
      ctrlPts.slice(i * vDimension, (i + 1) * vDimension))
  );

  return new ParametricGeometry(
    (u, v, target) => surface.getPoint(u, v, target),
    uDimension * 4, vDimension * 4
  );
}

// TriangleSet: raw triangle soup — vertices are already in order
function x3dTriangleSetToThree(node) {
  const coordNode = node["-coord"]?.Coordinate || node.Coordinate;
  const pts = coordNode?.["@point"] || [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.Float32BufferAttribute(pts, 3));
  geo.computeVertexNormals();
  return geo;
}

// IndexedTriangleSet: like above but with an index buffer
function x3dIndexedTriangleSetToThree(node) {
  const index = node["@index"] || [];
  const coordNode = node["-coord"]?.Coordinate || node.Coordinate;
  const pts = coordNode?.["@point"] || [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.Float32BufferAttribute(pts, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Convert triangle strips to triangle list
function stripToTriangles(strip) {
  const tris = [];
  for (let i = 0; i < strip.length - 2; i++) {
    tris.push(i % 2 === 0
      ? [strip[i], strip[i+1], strip[i+2]]
      : [strip[i+1], strip[i], strip[i+2]]);
  }
  return tris;
}

// Convert triangle fans to triangle list
function fanToTriangles(fan) {
  const tris = [];
  for (let i = 1; i < fan.length - 1; i++) {
    tris.push([fan[0], fan[i], fan[i+1]]);
  }
  return tris;
}

async function createTextGeometry(textData) {
      const fontStyle = textData['-fontStyle']?.FontStyle;
      const justify = fontStyle?.["@justify"] || ['BEGIN'];
      const family = (fontStyle?.["@family"] || ['SANS'])[0].toUpperCase();
      const fontFile = fontMap[family] || fontMap['SANS'];

      const font = await new Promise((resolve, reject) => {
        new FontLoader().load(
          fontFile,
          resolve, undefined, reject
        );
      });

      const strings = textData['@string'] || ['Text'];
      const size    = fontStyle?.['@size'] ?? 1;

      if (strings.length === 1) {
        const geometry = new THREE.TextGeometry(strings[0], { font, size, depth: 0, curveSegments: 12 });
        geometry.computeVertexNormals();
        return geometry;
      }

      const group = new THREE.Group();
      strings.forEach((str, index) => {
        const geometry = new THREE.TextGeometry(str, { font, size, depth: 0, curveSegments: 12 });
        if (justify[0] === 'MIDDLE') {
          geometry.computeBoundingBox();
          const centerX = (geometry.boundingBox.max.x - geometry.boundingBox.min.x) / 2;
          geometry.translate(-centerX, 0, 0);
        }
        if (justify[1] === 'MIDDLE') {
          geometry.computeBoundingBox();
          const centerY = (geometry.boundingBox.max.y - geometry.boundingBox.min.y) / 2;
          geometry.translate(0, -centerY, 0);
        }
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry);
        mesh.position.y = -index * size * 1.2;
        group.add(mesh);
      });
      return group;
};

function parseX3DGeometry(geomNode) {
    if (!geomNode) {
	    console.warn("No geomNode!");
	    return null;
    }

    // 3D primitives
    if (geomNode.Text) {
	return createTextGeometry(geomNode.Text);
    }
    if (geomNode.Extrusion) {
        const crossSection = geomNode.Extrusion["@crossSection"];
        const spine = geomNode.Extrusion["@spine"];
        const scale = geomNode.Extrusion["@scale"];
        const beginCap = geomNode.Extrusion["@beginCap"] ?? true;
        const endCap = geomNode.Extrusion["@endCap"] ?? true;

	// 1. Build the 2D Shape from crossSection
	const shape = new THREE.Shape();
	if (crossSection) {
	    for (let i = 0; i < crossSection.length; i += 2) {
	      const x = crossSection[i];
	      const y = crossSection[i + 1];
	      if (i === 0) shape.moveTo(x, y);
	      else shape.lineTo(x, y);
	    }
	    shape.closePath();
	}

	// 2. Build the spine as a CatmullRomCurve3
	const spinePoints = (spine || []).map(p => new THREE.Vector3(p[0], p[1], p[2]));
	const path = new THREE.CatmullRomCurve3(spinePoints);

        // 3. Extrude along spine path
	const extrudeSettings = {
	  steps: (spine || []).length * 4,
	  extrudePath: path,
	  bevelEnabled: false,
	};

	return new THREE.ExtrudeGeometry(shape, extrudeSettings);
    }
    if (geomNode.Box) {
        const s = geomNode.Box["@size"] || [1,1,1];
        return new THREE.BoxGeometry(s[0], s[1], s[2]);
    }
    if (geomNode.Sphere) {
        const r = geomNode.Sphere["@radius"] || 1;
        return new THREE.SphereGeometry(r, 32, 16);
    }
    if (geomNode.Cone) {
        const h = geomNode.Cone["@height"] || 2;
        const r = geomNode.Cone["@bottomRadius"] || 1;
        return new THREE.ConeGeometry(r, h, 32);
    }
    if (geomNode.Cylinder) {
        const h = geomNode.Cylinder["@height"] || 2;
        const r = geomNode.Cylinder["@radius"] || 1;
        return new THREE.CylinderGeometry(r, r, h, 32);
    }

    // Mesh-based
    if (geomNode.IndexedFaceSet) {
        const ifs = geomNode.IndexedFaceSet;
        const coordNode = ifs["-coord"]?.Coordinate || ifs.Coordinate;
        const coords = coordNode?.["@point"] || [];
        const indices = ifs["@coordIndex"] || [];

        const geom = new THREE.BufferGeometry();
        const verts = new Float32Array(coords);
        geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
        geom.setIndex(indices);
        geom.computeVertexNormals();
        return geom;
    }

    // ElevationGrid
    if (geomNode.ElevationGrid) {
        const eg = geomNode.ElevationGrid;
        const xDim = eg["@xDimension"];
        const zDim = eg["@zDimension"];
        const xStep = eg["@xSpacing"] || 1;
        const zStep = eg["@zSpacing"] || 1;
        const heights = eg["@height"] || [];

        const geom = new THREE.PlaneGeometry(
            xDim * xStep,
            zDim * zStep,
            xDim - 1,
            zDim - 1
        );

        const pos = geom.attributes.position;
        for (let i = 0; i < heights.length; i++) {
            pos.setY(i, heights[i]);
        }
        pos.needsUpdate = true;
        geom.computeVertexNormals();
        return geom;
    }

    // 2D primitives (extruded into 3D)
    if (geomNode.Rectangle2D) {
        const s = geomNode.Rectangle2D["@size"] || [1,1];
        return new THREE.PlaneGeometry(s[0], s[1]);
    }
    if (geomNode.Circle2D) {
        const r = geomNode.Circle2D["@radius"] || 1;
        return new THREE.CircleGeometry(r, 32);
    }
    if (geomNode.Disk2D) {
        const r = geomNode.Disk2D["@outerRadius"] || 1;
        return new THREE.RingGeometry(0, r, 32);
    }

    // Triangle sets
    if (geomNode.TriangleSet) {
        return x3dTriangleSetToThree(geomNode.TriangleSet);
    }

    if (geomNode.NurbsSurface) {
        return x3dNurbsSurfaceToThree(geomNode.NurbsSurface);
    }

    // Fallback
    console.warn("Unsupported X3D geometry:", geomNode);
    return null;
}

function createCompoundRigidBody(def, shapeNodes, mass, pos, colorArray) {
    const material = new THREE.MeshPhongMaterial({ color: new THREE.Color(...colorArray) });

    // Parent Three.js object representing the whole rigid body
    const parent = new THREE.Object3D();
    parent.position.set(pos[0], pos[1], pos[2]);
    scene.add(parent);

    // Bullet compound shape
    const compound = new Ammo.btCompoundShape();
    const localInertia = new Ammo.btVector3(0, 0, 0);

    shapeNodes.forEach(shapeNode => {
        const geomNode = shapeNode["-geometry"];
        const geometry = parseX3DGeometry(geomNode);
        if (!geometry) return;

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const sx = bb.max.x - bb.min.x;
        const sy = bb.max.y - bb.min.y;
        const sz = bb.max.z - bb.min.z;

        // Center of this geometry in its local space
        const cx = (bb.min.x + bb.max.x) * 0.5;
        const cy = (bb.min.y + bb.max.y) * 0.5;
        const cz = (bb.min.z + bb.max.z) * 0.5;

        // Three.js child mesh
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(cx, cy, cz);
        parent.add(mesh);

        // Bullet child shape
        const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
        shape.setMargin(margin);

        const childTransform = new Ammo.btTransform();
        childTransform.setIdentity();
        childTransform.setOrigin(new Ammo.btVector3(cx, cy, cz));

        compound.addChildShape(childTransform, shape);
    });

    // Compute inertia for the compound
    compound.calculateLocalInertia(mass, localInertia);

    const startTransform = new Ammo.btTransform();
    startTransform.setIdentity();
    startTransform.setOrigin(new Ammo.btVector3(pos[0], pos[1], pos[2]));

    const motionState = new Ammo.btDefaultMotionState(startTransform);
    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, compound, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    parent.userData.physicsBody = body;

    if (mass > 0) {
        rigidBodies.push(parent);
        body.setActivationState(4);
    }

    physicsWorld.addRigidBody(body);
    if (def) parsedBodiesMap[def] = { mesh: parent, body };
}

function parseRigidBodyCollection(collection) {
    if (!collection) {
        console.error("No RigidBodyCollection found.");
        return;
    }

    const gravity = collection["@gravity"] || [0, -9.8, 0];
    physicsWorld.setGravity(new Ammo.btVector3(gravity[0], gravity[1], gravity[2]));
    physicsWorld.getWorldInfo().set_m_gravity(new Ammo.btVector3(gravity[0], gravity[1], gravity[2]));

    // 1. Parse Bodies
    if (collection["-bodies"]) {
        collection["-bodies"].forEach(bodyNode => {
	    if (bodyNode.RigidBody) {
                const rb = bodyNode.RigidBody;
                const mass = rb["@mass"];
                const pos = rb["@position"];
                const def = rb["@DEF"];

                const shapeNodes = extractShapeNodes(rb["-geometry"]);
                if (!shapeNodes.length) {
                    console.warn("RigidBody has no shapeNodes:", rb);
                    return;
                }

                // Use the first shape’s color as the visual material color
                const firstShape = shapeNodes[0];
                const color = firstShape?.["-appearance"]?.Appearance?.["-material"]?.Material?.["@diffuseColor"] || [1, 1, 1];

                createCompoundRigidBody(def, shapeNodes, mass, pos, color);
            } else if (bodyNode.SoftBody) {
	        const sb = bodyNode.SoftBody;
                const shapeNodes = extractShapeNodes(sb["-geometry"]);
                if (!shapeNodes.length) {
                    console.warn("SoftBody has no shapeNodes:", sb);
                    return;
                }

                // Option 2: only use the first shape for soft bodies
                const shapeNode = shapeNodes[0];
                const geomNode = shapeNode["-geometry"];
                const col = shapeNode?.["-appearance"]?.Appearance?.["-material"]?.Material?.["@diffuseColor"] || [0.8, 0.8, 0.8];

                if (!geomNode) {
                    console.warn("SoftBody without geometry", sb);
                    return;
                }

                if (geomNode.ElevationGrid) {
                    createSoftBodyCloth(sb, shapeNode, col);
                } else if (geomNode.Sphere) {
                    createSoftBodySphere(sb, shapeNode, col);
                } else if (geomNode.Polyline2D || geomNode.NurbsCurve) {
                    createSoftBodyRope(sb, shapeNode, col);
                } else {
                    createSoftBodyFromGeometry(sb, shapeNode, col);
                }
            }
        });
    }

    // 2. Parse Joints
    if (collection["-joints"]) {
        collection["-joints"].forEach(jointNode => {
            if (jointNode.SingleAxisHingeJoint) {
                createHinge(jointNode.SingleAxisHingeJoint);
            } else if (jointNode.Stitch) {
                createStitch(jointNode.Stitch);
            }
        });
    }
}

function createRigidBodyFromGeometry(def, geometry, mass, pos, colorArray) {
    const material = new THREE.MeshPhongMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(pos[0], pos[1], pos[2]);
    scene.add(mesh);

    // Compute bounding box for collision shape
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;

    const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
    shape.setMargin(margin);

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    transform.setOrigin(new Ammo.btVector3(pos[0], pos[1], pos[2]));
    const motionState = new Ammo.btDefaultMotionState(transform);

    const localInertia = new Ammo.btVector3(0,0,0);
    shape.calculateLocalInertia(mass, localInertia);

    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    mesh.userData.physicsBody = body;

    if (mass > 0) {
        rigidBodies.push(mesh);
        body.setActivationState(4);
    }

    physicsWorld.addRigidBody(body);
    if (def) parsedBodiesMap[def] = { mesh, body };
}

function createSoftBodyFromGeometry(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"] || [0,0,0];
    const mass = sbConfig["@mass"] || 1;

    const geomNode = shapeNode["-geometry"];
    const geometry = parseX3DGeometry(geomNode);
    if (!geometry) {
        console.warn("SoftBody generic: unsupported geometry", geomNode);
        return;
    }

    geometry.computeVertexNormals();
    geometry.translate(pos[0], pos[1], pos[2]);

    const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(...colorArray),
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);

    // Build tri mesh for Ammo
    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const vertices = geometry.attributes.position.array;
    let indices;

    if (geometry.index) {
        indices = geometry.index.array;
    } else {
        // assume non‑indexed triangles
        indices = new Uint16Array(vertices.length / 3);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
    }

    const triMeshSoftBody = softBodyHelpers.CreateFromTriMesh(
        physicsWorld.getWorldInfo(),
        vertices,
        indices,
        indices.length / 3,
        true
    );

    const sbCfg = triMeshSoftBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    sbCfg.set_kDF(0.2);
    sbCfg.set_kDP(0.01);
    sbCfg.set_kPR(5);

    const sbMat = triMeshSoftBody.get_m_materials().at(0);
    sbMat.set_m_kLST(0.4);
    sbMat.set_m_kAST(0.4);
    sbMat.set_m_kVST(0.4);

    triMeshSoftBody.setTotalMass(mass, false);
    Ammo.castObject(triMeshSoftBody, Ammo.btCollisionObject)
        .getCollisionShape()
        .setMargin(margin);

    physicsWorld.addSoftBody(triMeshSoftBody, 1, -1);
    triMeshSoftBody.setActivationState(4);

    // Map geometry vertices to soft‑body nodes
    const nodes = triMeshSoftBody.get_m_nodes();
    const numNodes = nodes.size();
    const mapping = [];
    const positions = geometry.attributes.position.array;

    for (let i = 0; i < positions.length / 3; i++) {
        let vx = positions[i * 3];
        let vy = positions[i * 3 + 1];
        let vz = positions[i * 3 + 2];
        let minDist = Infinity;
        let minIdx = -1;
        for (let j = 0; j < numNodes; j++) {
            const nodePos = nodes.at(j).get_m_x();
            const dx = vx - nodePos.x();
            const dy = vy - nodePos.y();
            const dz = vz - nodePos.z();
            const dist = dx*dx + dy*dy + dz*dz;
            if (dist < minDist) {
                minDist = dist;
                minIdx = j;
            }
        }
        mapping.push(minIdx);
    }

    mesh.userData.physicsBody = triMeshSoftBody;
    mesh.userData.isGenericSoft = true;
    mesh.userData.mapping = mapping;

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh, body: triMeshSoftBody, isSoft: true };
    softBodies.push(mesh);
}

function createSoftBodyRope(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"] || [0,0,0];
    const mass = sbConfig["@mass"] || 1;

    const geomNode = shapeNode["-geometry"];
    let points = [];

    if (geomNode.Polyline2D) {
        const pts = geomNode.Polyline2D["@lineSegments"] || geomNode.Polyline2D["@point"] || [];
        for (let i = 0; i < pts.length; i += 2) {
            points.push(new THREE.Vector3(pts[i], pts[i+1], 0));
        }
    } else if (geomNode.NurbsCurve) {
        const coordNode = geomNode.NurbsCurve["-controlPoint"]?.Coordinate;
        const ctrl = coordNode?.["@point"] || [];
        for (let i = 0; i < ctrl.length; i += 3) {
            points.push(new THREE.Vector3(ctrl[i], ctrl[i+1], ctrl[i+2]));
        }
    }

    if (points.length < 2) {
        console.warn("Rope soft body: not enough points", geomNode);
        return;
    }

    // Three.js line for visualization
    const ropeGeom = new THREE.BufferGeometry().setFromPoints(points);
    ropeGeom.translate(pos[0], pos[1], pos[2]);
    const ropeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(...colorArray) });
    const ropeMesh = new THREE.Line(ropeGeom, ropeMat);
    ropeMesh.frustumCulled = false;
    scene.add(ropeMesh);

    // Ammo rope
    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const worldInfo = physicsWorld.getWorldInfo();

    const start = new Ammo.btVector3(points[0].x + pos[0], points[0].y + pos[1], points[0].z + pos[2]);
    const end   = new Ammo.btVector3(points[points.length-1].x + pos[0], points[points.length-1].y + pos[1], points[points.length-1].z + pos[2]);

    const ropeSoftBody = softBodyHelpers.CreateRope(worldInfo, start, end, points.length - 1, 0);
    ropeSoftBody.setTotalMass(mass, false);

    const sbCfg = ropeSoftBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    sbCfg.set_kDP(0.01);
    sbCfg.set_kDF(0.2);

    physicsWorld.addSoftBody(ropeSoftBody, 1, -1);
    ropeSoftBody.setActivationState(4);

    ropeMesh.userData.physicsBody = ropeSoftBody;
    ropeMesh.userData.isRope = true;

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh: ropeMesh, body: ropeSoftBody, isSoft: true };
    softBodies.push(ropeMesh);

    Ammo.destroy(start);
    Ammo.destroy(end);
}


function createRigidBody(def, size, mass, pos, colorArray) {
    const [sx, sy, sz] = size;
    const material = new THREE.MeshPhongMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(pos[0], pos[1], pos[2]);

    const shape = new Ammo.btBoxShape(new Ammo.btVector3(sx * 0.5, sy * 0.5, sz * 0.5));
    shape.setMargin(margin);

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    transform.setOrigin(new Ammo.btVector3(pos[0], pos[1], pos[2]));
    const motionState = new Ammo.btDefaultMotionState(transform);

    const localInertia = new Ammo.btVector3(0, 0, 0);
    shape.calculateLocalInertia(mass, localInertia);

    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    mesh.userData.physicsBody = body;
    scene.add(mesh);

    if (mass > 0) {
        rigidBodies.push(mesh);
        body.setActivationState(4); // Disable deactivation
    }
    physicsWorld.addRigidBody(body);
    if (def) parsedBodiesMap[def] = { mesh, body };
}

function createSoftBodyCloth(sbConfig, shapeNode, colorArray) {
    const pos = sbConfig["@position"] || [0,0,0];
    const mass = sbConfig["@mass"] || 1;

    const grid = shapeNode?.["-geometry"]?.ElevationGrid;
    const xDim = grid?.["@xDimension"] || 36;
    const zDim = grid?.["@zDimension"] || 26;
    const xSpacing = grid?.["@xSpacing"] || 0.2;
    const zSpacing = grid?.["@zSpacing"] || 0.2;

    const segZ = xDim - 1;
    const segY = zDim - 1;
    const width = segZ * xSpacing;
    const height = segY * zSpacing;

    const geometry = new THREE.PlaneBufferGeometry(width, height, segZ, segY);
    geometry.rotateY(Math.PI * 0.5);
    geometry.translate(pos[0], pos[1] + height * 0.5, pos[2] - width * 0.5);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray), side: THREE.DoubleSide });
    const clothMesh = new THREE.Mesh(geometry, material);
    clothMesh.castShadow = true; clothMesh.receiveShadow = true;
    clothMesh.frustumCulled = false;

    scene.add(clothMesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const corner00 = new Ammo.btVector3(pos[0], pos[1] + height, pos[2]);
    const corner01 = new Ammo.btVector3(pos[0], pos[1] + height, pos[2] - width);
    const corner10 = new Ammo.btVector3(pos[0], pos[1], pos[2]);
    const corner11 = new Ammo.btVector3(pos[0], pos[1], pos[2] - width);

    const clothSoftBody = softBodyHelpers.CreatePatch(physicsWorld.getWorldInfo(), corner00, corner01, corner10, corner11, segZ + 1, segY + 1, 0, true);

    const sbCfg = clothSoftBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
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
    const mass = sbConfig["@mass"] || 1;

    const sphere = shapeNode?.["-geometry"]?.Sphere;
    const radius = sphere?.["@radius"] || 1.0;

    const geometry = new THREE.SphereGeometry(radius, 32, 16);
    geometry.translate(pos[0], pos[1], pos[2]);

    const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...colorArray) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    scene.add(mesh);

    const softBodyHelpers = new Ammo.btSoftBodyHelpers();
    const center = new Ammo.btVector3(pos[0], pos[1], pos[2]);
    const radiusVec = new Ammo.btVector3(radius, radius, radius);

    const softBody = softBodyHelpers.CreateEllipsoid(physicsWorld.getWorldInfo(), center, radiusVec, 256);

    const sbCfg = softBody.get_m_cfg();
    sbCfg.set_viterations(10);
    sbCfg.set_piterations(10);
    sbCfg.set_kDF(0.1);
    sbCfg.set_kDP(0.01);
    sbCfg.set_kPR(10);

    const sbMat = softBody.get_m_materials().at(0);
    sbMat.set_m_kLST(0.15);
    sbMat.set_m_kAST(0.1);
    sbMat.set_m_kVST(0.1);

    softBody.setTotalMass(mass, false);
    Ammo.castObject(softBody, Ammo.btCollisionObject).getCollisionShape().setMargin(margin);

    softBody.generateBendingConstraints(2, sbMat);
    physicsWorld.addSoftBody(softBody, 1, -1);

    mesh.userData.physicsBody = softBody;
    mesh.userData.isSphere = true;
    softBody.setActivationState(4);

    const nodes = softBody.get_m_nodes();
    const numNodes = nodes.size();
    const mapping = [];
    const positions = geometry.attributes.position.array;

    for (let i = 0; i < positions.length / 3; i++) {
        let vx = positions[i * 3], vy = positions[i * 3 + 1], vz = positions[i * 3 + 2];
        let minDist = Infinity;
        let minIdx = -1;
        for (let j = 0; j < numNodes; j++) {
            let nodePos = nodes.at(j).get_m_x();
            let dx = vx - nodePos.x();
            let dy = vy - nodePos.y();
            let dz = vz - nodePos.z();
            let dist = dx * dx + dy * dy + dz * dz;
            if (dist < minDist) {
                minDist = dist;
                minIdx = j;
            }
        }
        mapping.push(minIdx);
    }
    mesh.userData.mapping = mapping;

    const def = sbConfig["@DEF"];
    if (def) parsedBodiesMap[def] = { mesh, body: softBody, isSoft: true };

    Ammo.destroy(center);
    Ammo.destroy(radiusVec);

    softBodies.push(mesh);
}

// { "CADAssembly": { "@name": "Engine", "-children": [...] } }
function x3dCADAssemblyToThree(node) {
  const group = new THREE.Group();
  group.name = node["@name"] || 'CADAssembly';

  (node["-children"] || []).forEach(child => {
    if (child.CADPart) {
      group.add(x3dCADPartToThree(child.CADPart));
    }
  });

  return group;
}

// X3D:
// { "CADPart": {
//     "@name": "Bolt",
//     "@translation": [1, 0, 0],
//     "@rotation": [0, 1, 0, 1.5708],
//     "@scale": [1, 1, 1],
//     "-children": [...]
// }}
function x3dCADPartToThree(node) {
  const group = new THREE.Group();
  group.name = node["@name"] || 'CADPart';

  // Apply transform
  const t = node["@translation"] || [0, 0, 0];
  const r = node["@rotation"]    || [0, 0, 1, 0]; // axis-angle
  const s = node["@scale"]       || [1, 1, 1];

  group.position.set(t[0], t[1], t[2]);
  group.quaternion.setFromAxisAngle(
    new THREE.Vector3(r[0], r[1], r[2]).normalize(), r[3]
  );
  group.scale.set(s[0], s[1], s[2]);

  (node["-children"] || []).forEach(child => {
    if (child.CADFace) {
      group.add(x3dCADFaceToThree(child.CADFace));
    }
  });

  return group;
}

// X3D:
// { "CADFace": {
//     "@name": "TopFace",
//     "-shape": { "Shape": {
//       "-appearance": { "Appearance": { "-material": { "Material": { "@diffuseColor": [0.8, 0.2, 0.2] } } } },
//       "-geometry": { "IndexedFaceSet": { ... } }
//     } }
// }}
function x3dCADFaceToThree(node) {
  const shape = node["-shape"]?.Shape || node.Shape;
  if (!shape) return new THREE.Group();

  let geometry;
  const geomNode = shape["-geometry"] || {};
  geometry = parseX3DGeometry(geomNode);

  if (!geometry) geometry = new THREE.BufferGeometry();

  // Build material from Appearance
  const appNode = shape["-appearance"]?.Appearance || {};
  const mat   = appNode["-material"]?.Material || {};
  const dc    = mat["@diffuseColor"]  || [0.8, 0.8, 0.8];
  const sc    = mat["@specularColor"] || [0.2, 0.2, 0.2];
  const shine = mat["@shininess"]     ?? 0.2;
  const trans = mat["@transparency"]  ?? 0;

  const material = new THREE.MeshPhongMaterial({
    color:     new THREE.Color(dc[0], dc[1], dc[2]),
    specular:  new THREE.Color(sc[0], sc[1], sc[2]),
    shininess: shine * 128,
    opacity:   1 - trans,
    transparent: trans > 0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = node["@name"] || 'CADFace';
  return mesh;
}

function parseX3DCAD(x3dJSON) {
  const root = new THREE.Group();

  function processNode(node, parent) {
    // Handle each possible CAD node type
    if (node.CADAssembly) {
      const group = x3dCADAssemblyToThree(node.CADAssembly);
      parent.add(group);
      (node.CADAssembly["-children"] || []).forEach(c => processNode(c, group));
    }
    else if (node.CADPart) {
      const part = x3dCADPartToThree(node.CADPart);
      parent.add(part);
      (node.CADPart["-children"] || []).forEach(c => processNode(c, part));
    }
    else if (node.CADFace) {
      parent.add(x3dCADFaceToThree(node.CADFace));
    }
    else if (node.Shape) {
      const mesh = x3dCADFaceToThree({ "-shape": { Shape: node.Shape } });
      parent.add(mesh);
    }
    else if (node.Transform) {
      const g = new THREE.Group();
      const t = node.Transform["@translation"] || [0, 0, 0];
      const r = node.Transform["@rotation"]    || [0, 0, 1, 0];
      const s = node.Transform["@scale"]       || [1, 1, 1];
      g.position.set(t[0], t[1], t[2]);
      g.quaternion.setFromAxisAngle(new THREE.Vector3(r[0], r[1], r[2]).normalize(), r[3]);
      g.scale.set(s[0], s[1], s[2]);
      parent.add(g);
      (node.Transform["-children"] || []).forEach(c => processNode(c, g));
    }
  }

  processNode(x3dJSON, root);
  return root;
}

// Usage
/*
const threeScene = parseX3DCAD(myX3DJsonData);
scene.add(threeScene);
*/

function x3dNurbsCurveToThree(node) {
  const coordNode = node["-controlPoint"]?.Coordinate;
  const pts = coordNode?.["@point"] || [];
  const points = [];
  for (let i = 0; i < pts.length; i += 3) {
      points.push(new THREE.Vector3(pts[i], pts[i+1], pts[i+2]));
  }
  const curve = points.length > 1 ? new THREE.CatmullRomCurve3(points) : new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3());
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return { curve, geometry };
}

function x3dNurbsCurveAsEdge(node, material = null) {
  const { curve, geometry } = x3dNurbsCurveToThree(node);

  const edgeMat = material || new THREE.LineBasicMaterial({
    color: 0x222222,
    linewidth: 1,
  });

  return new THREE.Line(geometry, edgeMat);
}

// Attach NURBS edges to a CAD face for a wireframe-style look
function buildCADFaceWithEdges(faceNode, curveNodes = []) {
  const group = new THREE.Group();
  group.add(x3dCADFaceToThree(faceNode));

  curveNodes.forEach(cn => {
    if (cn.NurbsCurve) {
      group.add(x3dNurbsCurveAsEdge(cn.NurbsCurve));
    }
  });

  return group;
}

function sweepShapeAlongNurbsCurve(shape2D, nurbsNode, steps = 50) {
  const { curve } = x3dNurbsCurveToThree(nurbsNode);

  const geo = new THREE.ExtrudeGeometry(shape2D, {
    extrudePath: curve,
    steps: steps,
    bevelEnabled: false,
  });

  return geo;
}

// Example: sweep a circular cross-section along a NURBS spine
/*
const circle = new THREE.Shape();
circle.absarc(0, 0, 0.1, 0, Math.PI * 2, false);

const tubeMesh = new THREE.Mesh(
  sweepShapeAlongNurbsCurve(circle, nurbsCurveNode),
  new THREE.MeshStandardMaterial({ color: 0x888888 })
);
scene.add(tubeMesh);
*/

function createHinge(jointConfig) {
    const b1Name = jointConfig["-body1"]?.RigidBody?.["@USE"] || jointConfig["@body1"];
    const b2Name = jointConfig["-body2"]?.RigidBody?.["@USE"] || jointConfig["@body2"];

    const b1 = parsedBodiesMap[b1Name];
    const b2 = parsedBodiesMap[b2Name];
    const ap = jointConfig["@anchorPoint"];
    const ax = jointConfig["@axis"];

    if (!b1 || !b2) {
        console.warn(`Hinge creation failed: Missing one or both connected bodies (${b1Name}, ${b2Name})`);
        return;
    }

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

    if (!rbEntry || !sbEntry) {
        console.warn(`Stitch creation failed: Missing rigid body (${rbName}) or soft body (${sbName})`);
        return;
    }

    const indices = (stitchConfig["@body1Index"] || []).map(Number);
    const weights = (stitchConfig["@weight"] || []).map(Number);

    const softBody = sbEntry.body;
    indices.forEach((nodeIndex, i) => {
        const weight = weights[i] !== undefined ? weights[i] : 1.0;
        softBody.appendAnchor(nodeIndex, rbEntry.body, false, weight);
    });
}

function initInput() {
    window.addEventListener('keydown', (e) => {
        if (e.keyCode === 81) armMovement = 1; // Q
        if (e.keyCode === 65) armMovement = -1; // A
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
    const deltaTime = clock.getDelta();

    if (globalHinge) globalHinge.enableAngularMotor(true, 0.8 * armMovement, 50);

    physicsWorld.stepSimulation(deltaTime, 10);

    // Update Soft Bodies
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
	} else if (mesh.userData.isCloth) {
	    const positions = mesh.geometry.attributes.position.array;
	    const numVerts = positions.length / 3;
	    let idx = 0;
	    for (let i = 0; i < numVerts; i++) {
		const nodePos = nodes.at(i).get_m_x();
		positions[idx++] = nodePos.x();
		positions[idx++] = nodePos.y();
		positions[idx++] = nodePos.z();
	    }
	    mesh.geometry.computeVertexNormals();
	    mesh.geometry.attributes.position.needsUpdate = true;
	    mesh.geometry.attributes.normal.needsUpdate = true;
	} else if (mesh.userData.isRope) {
	    const positions = mesh.geometry.attributes.position.array;
	    const numVerts = positions.length / 3;
	    let idx = 0;
	    for (let i = 0; i < numVerts; i++) {
		const nodePos = nodes.at(i).get_m_x();
		positions[idx++] = nodePos.x();
		positions[idx++] = nodePos.y();
		positions[idx++] = nodePos.z();
	    }
	    mesh.geometry.attributes.position.needsUpdate = true;
	}
    });

    // Update Rigid Bodies
    rigidBodies.forEach(obj => {
        const ms = obj.userData.physicsBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(transformAux1);
            const p = transformAux1.getOrigin();
            const q = transformAux1.getRotation();
            obj.position.set(p.x(), p.y(), p.z());
            obj.quaternion.set(q.x(), q.y(), q.z(), q.w());
        }
    });

    controls.update();
    renderer.render(scene, camera);
}
