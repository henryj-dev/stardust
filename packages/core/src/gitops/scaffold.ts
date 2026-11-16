/**
 * A component's manifests before its first delivery: whether a directory
 * already has one that uses the component's image, and a minimal set to
 * start from when it has none. A build whose image no manifest uses cannot
 * be delivered, so a run checks this before building.
 */
import { imageTagPattern } from "./image-tag.ts";

/** Whether any manifest (path → text) references `<host>/<project>/<component>:<tag>`. */
export function manifestUsesImage(files: ReadonlyMap<string, string>, project: string, component: string): boolean {
  for (const [path, text] of files) {
    if (!/\.ya?ml$/.test(path)) continue;
    if (imageTagPattern(project, component).test(text)) return true;
  }
  return false;
}

export interface ScaffoldInput {
  project: string;
  component: string;
  namespace: string;
  /** `<registry>/<project>/<component>`, without a tag. */
  imageRepository: string;
  /** The port the app listens on; omit for a workload without a Service. */
  port?: number;
  /**
   * Also declare the namespace, enforcing the restricted Pod Security
   * standard the Deployment meets. Withdrawing the component then removes it,
   * with everything in it: leave it off for a namespace other things share.
   */
  createNamespace?: boolean;
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A Deployment (one replica, the image at the tag `pending` until the first
 * delivery replaces it, restricted security context), a Service when there
 * is a port, and a kustomization listing them.
 */
export function scaffoldComponent(input: ScaffoldInput): Map<string, string> {
  for (const [what, value] of [
    ["component", input.component],
    ["namespace", input.namespace],
  ] as const) {
    if (!NAME.test(value)) throw new Error(`${what} must be a DNS label`);
  }
  if (!/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/.test(input.imageRepository)) {
    throw new Error("imageRepository must be a registry path without a tag");
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new Error("port must be 1-65535");
  }
  const name = input.component;
  const files = new Map<string, string>();
  if (input.createNamespace) {
    files.set(
      "namespace.yaml",
      `apiVersion: v1
kind: Namespace
metadata:
  name: ${input.namespace}
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
`,
    );
  }
  const labels = `app.kubernetes.io/name: ${name}\n        app.kubernetes.io/part-of: ${input.project}`;
  files.set(
    "deployment.yaml",
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${input.namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  template:
    metadata:
      labels:
        ${labels}
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: ${name}
          # stardust replaces the tag with each delivery.
          image: ${input.imageRepository}:pending
${
  input.port
    ? `          ports:
            - containerPort: ${input.port}
`
    : ""
}          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
`,
  );
  if (input.port) {
    files.set(
      "service.yaml",
      `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${input.namespace}
spec:
  selector:
    app.kubernetes.io/name: ${name}
  ports:
    - port: ${input.port}
      targetPort: ${input.port}
`,
    );
  }
  files.set(
    "kustomization.yaml",
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${[...files.keys()].map((f) => `  - ${f}`).join("\n")}
`,
  );
  return files;
}
