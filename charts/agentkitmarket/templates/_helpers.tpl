{{/*
Expand the name of the chart.
*/}}
{{- define "agentkitmarket.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agentkitmarket.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitmarket.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — API
*/}}
{{- define "agentkitmarket.selectorLabelsApi" -}}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Selector labels — worker
*/}}
{{- define "agentkitmarket.selectorLabelsWorker" -}}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Selector labels — web
*/}}
{{- define "agentkitmarket.selectorLabelsWeb" -}}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{/*
Web ConfigMap name
*/}}
{{- define "agentkitmarket.webConfigmapName" -}}
{{ include "agentkitmarket.fullname" . }}-web-config
{{- end }}

{{/*
Web Secret name (chart-managed)
*/}}
{{- define "agentkitmarket.webSecretName" -}}
{{ include "agentkitmarket.fullname" . }}-web-secret
{{- end }}

{{/*
Effective web Secret name — the existing Secret if provided, else chart-managed.
*/}}
{{- define "agentkitmarket.webEffectiveSecretName" -}}
{{- if .Values.web.secrets.existingSecret -}}
{{ .Values.web.secrets.existingSecret }}
{{- else -}}
{{ include "agentkitmarket.webSecretName" . }}
{{- end -}}
{{- end }}

{{/*
ConfigMap name
*/}}
{{- define "agentkitmarket.configmapName" -}}
{{ include "agentkitmarket.fullname" . }}-config
{{- end }}

{{/*
Secret name
*/}}
{{- define "agentkitmarket.secretName" -}}
{{ include "agentkitmarket.fullname" . }}-secret
{{- end }}

{{/*
---------------------------------------------------------------------------
Secret generation / persistence helpers.

Each "effective<X>" template resolves to, in order:
  1. the explicitly-set value, if provided;
  2. (when secrets.generate is true) the value PERSISTED from a prior install,
     read via `lookup` from the live chart-managed Secret — so `helm upgrade`
     keeps the strong random value that was minted on the first successful
     install; otherwise
  3. a generated fallback that is DETERMINISTIC within a single render.

Why deterministic on first install? Helm evaluates every template
independently, so a bare `randAlphaNum` would mint a DIFFERENT value in each of
the backend Secret, the postgres/minio Secrets, and the web Secret — the
DATABASE_URL password wouldn't match the Postgres container's, and the web
admin key wouldn't match the backend's. Seeding the fallback from the release
identity makes all templates agree on first render. After that first install,
`lookup` returns the persisted value and (1)/(2) take over — so the live
credential is the one minted at install time and never drifts.
---------------------------------------------------------------------------
*/}}

{{/*
Deterministic per-release fallback for a named credential. Stable across all
templates in one render and across upgrades; only used until the live Secret
exists. args: (list $ "PURPOSE_KEY")
*/}}
{{- define "agentkitmarket._seededSecret" -}}
{{- $root := index . 0 -}}
{{- $purpose := index . 1 -}}
{{- printf "%s/%s/%s" $root.Release.Namespace $root.Release.Name $purpose | sha256sum -}}
{{- end }}

{{/* Read a base64 key from a live Secret by name, decoded; "" if missing/dry-run. */}}
{{- define "agentkitmarket._liveSecretValue" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $key := index . 2 -}}
{{- $live := (lookup "v1" "Secret" $root.Release.Namespace $name) | default dict -}}
{{- $data := $live.data | default dict -}}
{{- if hasKey $data $key -}}
{{- index $data $key | b64dec -}}
{{- end -}}
{{- end }}

{{/* Effective ADMIN_API_KEY (explicit | persisted | seeded-fallback). */}}
{{- define "agentkitmarket.effectiveAdminApiKey" -}}
{{- if .Values.secrets.adminApiKey -}}
{{- .Values.secrets.adminApiKey -}}
{{- else if .Values.secrets.generate -}}
{{- $prev := include "agentkitmarket._liveSecretValue" (list . (include "agentkitmarket.secretName" .) "ADMIN_API_KEY") -}}
{{- $prev | default (include "agentkitmarket._seededSecret" (list . "admin-api-key")) -}}
{{- else -}}
{{- required "set secrets.adminApiKey or enable secrets.generate or use an existing secret" .Values.secrets.adminApiKey -}}
{{- end -}}
{{- end }}

{{/* Effective Postgres password (explicit | persisted | seeded-fallback). */}}
{{- define "agentkitmarket.effectivePostgresPassword" -}}
{{- if .Values.postgres.password -}}
{{- .Values.postgres.password -}}
{{- else if .Values.secrets.generate -}}
{{- $prev := include "agentkitmarket._liveSecretValue" (list . (include "agentkitmarket.secretName" .) "POSTGRES_PASSWORD") -}}
{{- $prev | default (include "agentkitmarket._seededSecret" (list . "postgres-password")) -}}
{{- else -}}
{{- required "set postgres.password or enable secrets.generate" .Values.postgres.password -}}
{{- end -}}
{{- end }}

{{/* Effective MinIO root password (explicit | persisted | seeded-fallback). */}}
{{- define "agentkitmarket.effectiveMinioPassword" -}}
{{- if .Values.minio.rootPassword -}}
{{- .Values.minio.rootPassword -}}
{{- else if .Values.secrets.generate -}}
{{- $prev := include "agentkitmarket._liveSecretValue" (list . (include "agentkitmarket.secretName" .) "MINIO_ROOT_PASSWORD") -}}
{{- $prev | default (include "agentkitmarket._seededSecret" (list . "minio-password")) -}}
{{- else -}}
{{- required "set minio.rootPassword or enable secrets.generate" .Values.minio.rootPassword -}}
{{- end -}}
{{- end }}

{{/*
Effective web SESSION_SECRET (OIDC): explicit | persisted | seeded-fallback.
Only emitted when authProvider=oidc.
*/}}
{{- define "agentkitmarket.effectiveSessionSecret" -}}
{{- if .Values.web.secrets.sessionSecret -}}
{{- .Values.web.secrets.sessionSecret -}}
{{- else -}}
{{- $prev := include "agentkitmarket._liveSecretValue" (list . (include "agentkitmarket.webSecretName" .) "SESSION_SECRET") -}}
{{- $prev | default (include "agentkitmarket._seededSecret" (list . "session-secret")) -}}
{{- end -}}
{{- end }}

{{/*
Effective web admin key: explicit web.secrets.adminApiKey, else reuse the
backend effective admin key (so a self-hoster sets one key, not two).
*/}}
{{- define "agentkitmarket.effectiveWebAdminApiKey" -}}
{{- if .Values.web.secrets.adminApiKey -}}
{{- .Values.web.secrets.adminApiKey -}}
{{- else -}}
{{- include "agentkitmarket.effectiveAdminApiKey" . -}}
{{- end -}}
{{- end }}
