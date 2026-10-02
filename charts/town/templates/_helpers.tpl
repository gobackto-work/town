{{/* The component name. Fixed by default: pestilence reaches town by Service name. */}}
{{- define "town.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The namespace town runs in. */}}
{{- define "town.namespace" -}}
{{- default "town" .Values.namespace.name -}}
{{- end -}}

{{- define "town.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "town.name" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "town.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "town.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
agents.gobackto.work/component: town
{{- end -}}

{{/* The selector subset. Never change these: they are immutable on a Deployment. */}}
{{- define "town.selectorLabels" -}}
app.kubernetes.io/name: {{ include "town.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
agents.gobackto.work/component: town
{{- end -}}

{{/* The image reference, tag defaulting to the chart's appVersion. */}}
{{- define "town.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* The name of the secret holding the GitHub client secret and session secret. */}}
{{- define "town.secretName" -}}
{{- default "town-secrets" .Values.secrets.github.existingSecret -}}
{{- end -}}

{{/* The name of the secret holding the Ed25519 assertion private key. */}}
{{- define "town.assertionSecretName" -}}
{{- default "town-assertion-key" .Values.assertion.existingSecret -}}
{{- end -}}
