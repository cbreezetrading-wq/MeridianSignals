#!/usr/bin/env bun
/** Operator helper: close every Meridian-managed position via control 3. */
import { bootstrapClient } from "../lib/bootstrap.ts";
import { closeManagedPositions } from "../lib/ops.ts";
const { client } = await bootstrapClient();
const r = await closeManagedPositions(client, "operator: reset to a flat account between verification passes");
console.log(JSON.stringify(r, null, 2));
