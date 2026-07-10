#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';

if (!process.env.NODE_ENV && !process.argv.includes('--dev')) process.env.NODE_ENV = 'production';

await tsImport('./next-server.ts', import.meta.url);
