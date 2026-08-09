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
  {
    id: 'statefulset',
    label: 'A StatefulSet with problems',
    blurb: 'A governing Service that is not a valid name, a mount that matches no claim template, and an update strategy that contradicts itself.',
    yaml: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  # A Service name is a DNS label, so it cannot carry a dot or a capital.
  serviceName: DB.headless
  replicas: 3
  podManagementPolicy: Ordered
  selector:
    matchLabels:
      app: db
  updateStrategy:
    type: OnDelete
    rollingUpdate:
      partition: -1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
              name: postgres
          volumeMounts:
            # The claim template below is called "data", not "date".
            - name: date
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10G1
`,
  },
  {
    id: 'daemonset',
    label: 'A DaemonSet with problems',
    blurb: 'A replica count that does not exist, a rollout that asks for both update modes at once, and a mount that points nowhere.',
    yaml: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  # A DaemonSet runs one Pod per matching node, so it has no replica count.
  replicas: 3
  selector:
    matchLabels:
      app: node-exporter
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      restartPolicy: OnFailure
      hostNetwork: true
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.2
          ports:
            - name: metrics
              containerPort: 9100
              hostPort: 9101
          volumeMounts:
            # The volume below is called "procfs", not "proc".
            - name: proc
              mountPath: /host/proc
              readOnly: true
      volumes:
        - name: procfs
          hostPath:
            path: /proc
`,
  },
  {
    id: 'service',
    label: 'A Service with problems',
    blurb: 'A name that is not a DNS label, a headless Service asking for a node port, and two ports that collide.',
    yaml: `apiVersion: v1
kind: Service
metadata:
  # A Service name is an RFC 1035 label, so it cannot start with a digit.
  name: 8080-proxy
spec:
  type: NodePort
  # NodePort builds on a cluster IP, so this Service cannot also be headless.
  clusterIP: None
  externalTrafficPolicy: local
  selector:
    app: web
  ports:
    - name: http
      port: 80
      # Quoted, this names a container port rather than the number 8080.
      targetPort: "8080"
      nodePort: 8080
    - name: http
      port: 80
`,
  },
  {
    id: 'ingress',
    label: 'An Ingress with problems',
    blurb:
      'A class set two ways at once, a host that is an IP, a relative path, a backend port named twice and a certificate for a host nothing routes.',
    yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  annotations:
    # IngressClass replaced this in 1.18, and it disagrees with the field below.
    kubernetes.io/ingress.class: nginx
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - checkout.example.com
      secretName: shop-tls
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: prefix
            backend:
              service:
                name: shop-web
                port:
                  # A backend picks a Service port by name or by number, not both.
                  name: http
                  number: 80
          - path: api/v1
            pathType: Prefix
            backend:
              service:
                name: shop-api
    # An Ingress routes by the Host header, so a rule names a host, not an address.
    - host: 203.0.113.10
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: shop-web
                port:
                  number: 80
`,
  },
];
