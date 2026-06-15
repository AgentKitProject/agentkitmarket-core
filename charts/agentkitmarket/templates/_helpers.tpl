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
