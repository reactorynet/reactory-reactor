# Kubernetes Deployment & GitOps Operations Skill

**Skill ID:** `reactory.kubernetesDeployment@1.0.0`  
**Namespace:** `reactory`  
**Description:** Comprehensive methodology, toolchain, and operational workflows for deploying, diagnosing, hot-patching, and managing Reactory workloads on Kubernetes and GitOps engines (ArgoCD).

---

## 1. Overview & Architecture

Reactory on Kubernetes operates as a micro-service and stateful topology consisting of:

### 1.1 Dual-Domain Ingress & Host Decoupling
To eliminate path routing collisions, prevent static Nginx 405 errors, and allow arbitrary REST endpoints contributed by custom modules (`/kyc/*`, `/speech/*`, `/pdf/*`, `/auth/*`, `/graphql`), Reactory uses dedicated hostnames:
* **Web Frontend Domain (`<app>-web.<domain>`, e.g. `demo-apex-web.reactory.net`):**
  * Ingress routes `/*` (catch-all) directly to `reactory-pwa-client:80`.
  * Handles React SPA routing via Nginx `try_files $uri $uri/ /index.html` with zero backend path collisions.
* **API Backend Domain (`<app>-api.<domain>`, e.g. `demo-apex-api.reactory.net`):**
  * Ingress routes `/*` (catch-all) directly to `reactory-express-server:4000`.
  * Handles Express & Apollo GraphQL Server, authentication routes, module REST endpoints, and WebSocket/SSE streaming.
  * Configured with `proxy-buffering: "off"`, `proxy-read-timeout: "3600"`, and `proxy-body-size: "64m"`.

### 1.2 Data Layer Services
* **MongoDB:** Primary application document store (Clients, Users, Content, Forms, Workflows).
* **PostgreSQL:** Relational application data & enterprise schemas.
* **Valkey / Redis:** Session cache, Pub/Sub AMQ bus, rate limiting.
* **Meilisearch:** Full-text indexing and instant search.

---

## 2. Deployment Toolchain & Commands

### 2.1 Terraform Layered Provisioning (DigitalOcean / Linode / AWS)
Always deploy and destroy infrastructure in explicit layer order:
```bash
# 1. Network & Cluster Layer
cd config/reactory/terraform/linode/environments/small/cluster
terraform init -upgrade
terraform apply -auto-approve

# 2. Extract Kubeconfig
export CLUSTER_ID=$(terraform output -raw cluster_id)
linode-cli lke kubeconfig-view $CLUSTER_ID --text --no-headers | base64 --decode > ~/.kube/reactory-small.yaml
export KUBECONFIG=~/.kube/reactory-small.yaml

# 3. Workload Layer
cd ../workload
terraform init -upgrade
terraform apply -auto-approve
```

---

## 3. Container Inspection, In-Cluster Patching & Verification

When operating on remote clusters where immediate image rebuilds or debugging is required without waiting for full CI/CD loops:

### 3.1 Privileged Image Loader Daemon (Host Containerd Injection)
To inspect or hot-patch image layers directly into the node's containerd storage:
```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: image-loader
  namespace: kube-system
spec:
  hostPID: true
  containers:
  - name: loader
    image: docker.io/library/alpine:latest
    command: ["sleep", "3600"]
    securityContext:
      privileged: true
    volumeMounts:
    - name: host-root
      mountPath: /host
  volumes:
  - name: host-root
    hostPath:
      path: /
EOF
```

### 3.2 Executing Container Operations Inside Host Daemon
```bash
kubectl exec -n kube-system image-loader -- nsenter -t 1 -m -u -i -n -p -- sh -c "
  docker build -t ghcr.io/reactorynet/reactory-express-server:1.1.0 /tmp/patch
  docker save ghcr.io/reactorynet/reactory-express-server:1.1.0 | ctr -n k8s.io images import -
"
```

---

## 4. Troubleshooting & Diagnostic Playbook

| Issue / Symptom | Diagnostic Step | Root Cause & Resolution |
| :--- | :--- | :--- |
| **`405 Not Allowed` on API / Login calls** | Check Ingress paths via `kubectl get ingress reactory-ingress -n reactory -o yaml` | Backend route is falling back to static Nginx client. Add path to Ingress backend rules. |
| **Pod CrashLoopBackOff on `/health`** | Run `kubectl describe pod ...` and check `HealthRouter.ts` | Ensure `/health` is in `bypassUri` and returns `200 OK` once system context is ready. Set `initialDelaySeconds: 180`. |
| **`401 Credentials Invalid` on Client Boot** | Query `db.reactory_clients.findOne({key: 'reactory'})` in Mongo | Client password hash in Mongo doesn't match `REACT_APP_CLIENT_PASSWORD` in the web bundle. |
| **`System Unavailable` on initial load** | Verify `anon@reactor.local` in `reactory_users` | Anonymous bootstrap user missing from database or lacks `ANON` role membership. |
| **`401 Unauthorized` on GraphQL queries after login** | Inspect `user.sessionInfo` in MongoDB | `clientKey` mismatch between minted session and requesting header. Verify `'api'` is in `UNSCOPED_CLIENT_KEYS`. |
| **"Waiting for application components..."** | Check `registeredComponents` in `window.reactory.api` | `reactory.client.core.js` plugin not loaded or failed URL delivery. Update Mongo plugin URI to valid CDN route. |

---

## 5. Clean Cluster Teardown Procedure

To avoid dangling block storage volumes or lingering cloud costs:
```bash
# 1. Delete workload namespaces to trigger CSI PVC volume detach & deletion
kubectl delete namespace reactory ingress-nginx cert-manager --timeout=120s

# 2. Destroy cluster layer
cd config/reactory/terraform/linode/environments/small/cluster
terraform destroy -auto-approve

# 3. Clean up orphaned cloud volumes via Cloud API
for id in $(curl -s -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/volumes | jq -r '.data[].id'); do
  curl -s -X DELETE -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/volumes/$id
done
```
