import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createGeometryWorkerClient } from "@craftbit/geometry-worker";
import { buildGeometryFromTessellation } from "./buildMesh";

// GP-1 bracket footprint (spec §2.2) as the M0 hardcoded demo body.
const DEMO_BOX_MM: readonly [number, number, number] = [60, 40, 5];

export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1b1e);

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      10000,
    );
    camera.position.set(120, -160, 110);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.domElement.classList.add("viewport-canvas");
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(DEMO_BOX_MM[0] / 2, DEMO_BOX_MM[1] / 2, DEMO_BOX_MM[2] / 2);
    controls.enableDamping = true;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x33343a, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(150, -200, 300);
    scene.add(keyLight);

    const grid = new THREE.GridHelper(200, 20, 0x3f3f46, 0x2a2a2e);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    let frameId = 0;
    const renderLoop = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    const worker = createGeometryWorkerClient();
    worker.api
      .makeBox(...DEMO_BOX_MM)
      .then((mesh) => {
        if (disposed) return;
        const geometry = buildGeometryFromTessellation(mesh);
        const material = new THREE.MeshStandardMaterial({
          color: 0x8ab4f8,
          metalness: 0.1,
          roughness: 0.6,
        });
        const box = new THREE.Mesh(geometry, material);
        scene.add(box);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        console.error("Failed to build demo box via OCCT worker:", err);
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      worker.terminate();
    };
  }, []);

  return (
    <div className="viewport-root" ref={containerRef}>
      {status === "loading" && (
        <div className="loading-overlay">Loading OpenCascade kernel&hellip;</div>
      )}
      {status === "error" && (
        <div className="loading-overlay">Failed to load kernel — see console.</div>
      )}
    </div>
  );
}
