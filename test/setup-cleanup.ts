import { afterAll } from "vitest";
import { cleanupMadeDirs } from "./helpers.js";

// F-vlad-105: temp homes/fixture roots created by a test file are removed when the file ends
afterAll(() => cleanupMadeDirs());
