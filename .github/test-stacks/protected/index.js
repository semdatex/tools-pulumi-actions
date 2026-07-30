"use strict";
const pulumi = require("@pulumi/pulumi");
const dynamic = require("@pulumi/pulumi/dynamic");

// In-memory dynamic resource: no provider plugin, no cloud, no network.
class Noop extends dynamic.Resource {
  constructor(name, opts) {
    super({ create: async () => ({ id: name, outs: {} }) }, name, {}, opts);
  }
}

const cfg = new pulumi.Config();

// boom=true: fail for a reason that has nothing to do with protection.
if (cfg.getBoolean("boom")) {
  throw new Error("fixture exploded (non-protection failure)");
}

new Noop("plain");

// guarded=false: drop the protected resource from the program, so the next
// preview plans its delete and the engine refuses it.
if (cfg.getBoolean("guarded") !== false) {
  new Noop("guarded", { protect: true });
}
