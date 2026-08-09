export interface Example {
  id: string;
  label: string;
  blurb: string;
  yaml: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'broken',
    label: 'A Pod with problems',
    blurb: 'A misspelled field, a bad enum, an impossible port and a mount that points nowhere.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: Broken-Pod
  labels:
    app: web
spec:
  # "containers" is misspelled, so everything below it is invisible to the API.
  contaienrs:
    - name: web
      image: nginx:1.27-alpine
      imagePullPolicy: always
      ports:
        - containerPort: 70000
          name: http
      resources:
        requests:
          cpu: "500m"
          memory: 512m
        limits:
          cpu: "200m"
      livenessProbe:
        httpGet:
          port: htpp
        successThreshold: 3
      volumeMounts:
        - name: data-volme
          mountPath: /data
  volumes:
    - name: data-volume
      emptyDir: {}
  restartPolicy: always
`,
  },
  {
    id: 'valid',
    label: 'A valid Pod',
    blurb: 'Nothing to report — useful for checking that a clean manifest stays clean.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: web
  namespace: default
  labels:
    app.kubernetes.io/name: web
spec:
  restartPolicy: Always
  containers:
    - name: web
      image: nginx:1.27-alpine
      ports:
        - name: http
          containerPort: 8080
          protocol: TCP
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
      readinessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
      volumeMounts:
        - name: cache
          mountPath: /var/cache/nginx
  volumes:
    - name: cache
      emptyDir: {}
`,
  },
  {
    id: 'sidecar',
    label: 'Init containers and sidecars',
    blurb: 'Probes on a plain init container are rejected; a sidecar needs restartPolicy: Always.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: app-with-sidecar
spec:
  initContainers:
    # A log shipper meant to run for the lifetime of the Pod.
    - name: log-shipper
      image: fluent/fluent-bit:3.1
      readinessProbe:
        tcpSocket:
          port: 2020
    - name: migrate
      image: migrate/migrate:v4
      command: ["migrate", "up"]
  containers:
    - name: app
      image: app:1.4.2
      env:
        - name: DATABASE_URL
          value: postgres://db/app
          valueFrom:
            secretKeyRef:
              name: db
              key: url
`,
  },
  {
    id: 'conflicts',
    label: 'Contradictory settings',
    blurb: 'Settings that are individually valid but cannot be combined.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: conflicted
spec:
  hostNetwork: true
  hostPID: true
  shareProcessNamespace: true
  serviceAccount: legacy
  serviceAccountName: modern
  dnsPolicy: None
  securityContext:
    runAsNonRoot: true
    runAsUser: 0
  tolerations:
    - key: dedicated
      operator: Exists
      value: batch
      effect: NoSchedule
      tolerationSeconds: 30
  containers:
    - name: app
      image: app:1.0.0
      ports:
        - containerPort: 8080
          hostPort: 9090
      securityContext:
        privileged: true
        allowPrivilegeEscalation: false
`,
  },
  {
    id: 'deployment',
    label: 'A Deployment with problems',
    blurb: 'A selector that does not match its template, a run-to-completion pod spec and an impossible rollout.',
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      # The template below labels its Pods "web", so this selects nothing.
      app: frontend
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 0
  minReadySeconds: 30
  progressDeadlineSeconds: 30
  template:
    metadata:
      labels:
        app: web
    spec:
      restartPolicy: OnFailure
      activeDeadlineSeconds: 600
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports:
            - containerPort: 8080
              name: http
`,
  },
];
