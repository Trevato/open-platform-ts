import { isValidName, Result, TaggedError } from "@op/core";

export class PolicyViolation extends TaggedError("PolicyViolation")<{
  reason: string;
  subject: string;
}>() {}

// Desired state for one app — the whole contract between a user and the
// platform, stored at apps/<owner>/<app>/app.json in sys/gitops.
export interface AppSpec {
  owner: string;
  app: string;
  repo: { owner: string; name: string };
  ref: string;
  containerPort: number;
  data: boolean;
}

// Admission is the ONLY path to a deploy, and it fails closed: a spec that
// doesn't parse cleanly never reaches the reconciler. There is no audit mode.
export function admitSpec(
  raw: unknown,
  ctx: { domain: string },
): Result<AppSpec, PolicyViolation> {
  const deny = (reason: string, subject = "app.json") =>
    Result.err(new PolicyViolation({ reason, subject }));

  if (typeof raw !== "object" || raw === null)
    return deny("spec is not an object");
  const s = raw as Record<string, unknown>;

  if (typeof s["owner"] !== "string" || !isValidName(s["owner"]))
    return deny("invalid owner");
  if (typeof s["app"] !== "string" || !isValidName(s["app"]))
    return deny("invalid app name");

  const repo = s["repo"] as Record<string, unknown> | undefined;
  if (
    typeof repo !== "object" ||
    repo === null ||
    typeof repo["owner"] !== "string" ||
    typeof repo["name"] !== "string" ||
    !isValidName(repo["owner"]) ||
    !isValidName(repo["name"])
  ) {
    return deny("invalid repo reference");
  }

  const ref = s["ref"];
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9._/-]{1,100}$/.test(ref) ||
    ref.includes("..")
  )
    return deny("invalid ref");

  const port = s["containerPort"];
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return deny("invalid containerPort");

  if (typeof s["data"] !== "boolean") return deny("data must be boolean");

  const spec: AppSpec = {
    owner: s["owner"],
    app: s["app"],
    repo: { owner: repo["owner"], name: repo["name"] },
    ref,
    containerPort: port,
    data: s["data"],
  };

  // Host ownership: an app claims exactly its derived host on the platform
  // domain — nothing else routes to it, so no spec can shadow another tenant.
  void ctx;
  return Result.ok(spec);
}

export function hostFor(spec: AppSpec, domain: string): string {
  return `${spec.app}-${spec.owner}.${domain}`;
}

// Provenance, structurally: the reconciler deploys only images it just built
// itself, tagged under the platform prefix. A spec cannot name a foreign image.
export function admitImageTag(
  tag: string,
  spec: AppSpec,
): Result<void, PolicyViolation> {
  if (!tag.startsWith(`op/${spec.owner}-${spec.app}:`)) {
    return Result.err(
      new PolicyViolation({
        reason: `image tag ${tag} not platform-built`,
        subject: tag,
      }),
    );
  }
  return Result.ok(undefined);
}
