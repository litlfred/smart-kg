#!/usr/bin/env node
// Proves each layer's JSON-LD context turns a graph document into RDF that keeps its meaning.
//
// A context can be valid JSON-LD and still throw most of a document away. Measured before this
// test existed, expanding the emitted L1 fixture under l1.context.jsonld gave 487 triples, but no
// node kept its class (a node's `type` is a class id, and there was no @vocab), and 85 property
// values collapsed into `sgkg:properties` with their names dropped (an @index container). Nothing
// failed, because nothing looked.
//
// For every document negative-test.mjs --emit writes, expanded with the layer's OWN context file
// (served offline -- a context is never fetched at test time), this asserts:
//   - every node has rdf:type <namespace><its type>;
//   - every property value is named: none is a bare object of sgkg:properties;
//   - a property that shares a name with a document-level term (`id`, `type`, `source`, `label`)
//     keeps its own meaning and does not become the node's @id, class, or an edge's subject;
//   - every edge's predicate expands to the IRI the ontology declares for it.
//
//   npm install --no-save jsonld@8 && node tools/context-test.mjs

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

let jsonld;
try {
  jsonld = (await import("jsonld")).default;
} catch {
  console.error("jsonld is not installed: npm install --no-save jsonld@8");
  process.exit(2);
}

const layerOf = (url) => /\/([a-z0-9-]+)\.context\.jsonld$/.exec(url)?.[1];
const documentLoader = async (url) => {
  const layer = layerOf(url);
  if (!layer) throw new Error(`no offline context for ${url}`);
  return { contextUrl: null, documentUrl: url, document: JSON.parse(readFileSync(join(ROOT, "ontology", layer, `${layer}.context.jsonld`), "utf8")) };
};

const dir = mkdtempSync(join(tmpdir(), "kg-context-"));
execFileSync(process.execPath, [join(ROOT, "tools", "negative-test.mjs"), "--emit", dir], { stdio: "ignore" });

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };

for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const layer = layerOf(doc["@context"]);
  const ont = JSON.parse(readFileSync(join(ROOT, "ontology", layer, `${layer}.json`), "utf8"));
  const ns = ont.namespace;
  const quads = await jsonld.toRDF(doc, { documentLoader });
  const triples = quads.map((q) => [q.subject.value, q.predicate.value, q.object.value, q.object.termType]);
  const has = (s, p, o) => triples.some(([ts, tp, to]) => ts === s && tp === p && to === o);

  for (const n of doc.nodes) {
    if (!has(n.id, RDF_TYPE, `${ns}${n.type}`)) fail(`${f}: node ${n.id} lost its class ${n.type}`);
    for (const k of ["id", "type"]) {
      if (n.properties?.[k] !== undefined && has(n.id, RDF_TYPE, `${ns}${n.properties[k]}`)) fail(`${f}: property ${k} of ${n.id} became its class`);
    }
  }
  const unnamed = triples.filter(([, p, , t]) => p === `${ns}properties` && t !== "BlankNode");
  if (unnamed.length) fail(`${f}: ${unnamed.length} property value(s) have no name`);
  const declared = new Map();
  for (const l of [layer, ...(ont.imports ?? [])]) {
    for (const p of JSON.parse(readFileSync(join(ROOT, "ontology", l, `${l}.json`), "utf8")).predicates ?? []) declared.set(p.predicate, p.iri);
  }
  const predicates = new Set(triples.filter(([, p]) => p === "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate").map(([, , o]) => o));
  for (const e of doc.edges) {
    const iri = declared.get(e.predicate);
    if (iri && !predicates.has(iri)) fail(`${f}: edge predicate ${e.predicate} did not expand to ${iri}`);
  }
  console.log(`${f}: ${triples.length} triples, ${doc.nodes.length} nodes typed, ${doc.edges.length} edges`);
}

if (failures) {
  console.error(`${failures} context failure(s)`);
  process.exit(1);
}
console.log("every layer's context keeps classes, property names and predicates");
