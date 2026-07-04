import { Vector3, Color } from "three";
import { uniform } from "three/tsl";

export const cursorLightPos = uniform(new Vector3());
export const cursorLightColor = uniform(new Color());
export const cursorLightIntensity = uniform(0);
