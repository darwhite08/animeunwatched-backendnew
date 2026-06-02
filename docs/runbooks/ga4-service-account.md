# Runbook — connect GA4 to the admin dashboard

The admin dashboard's "Google Analytics 4 · Realtime" tile reads from the
GA4 Data API server-side. To turn it on you need to give the backend a
service account with **Viewer** access to the GA4 property.

Whole thing takes ~5 minutes, all in the browser.

---

## 0. What you'll set in App Runner at the end

Two env vars:

| Name | Value |
|---|---|
| `GA_PROPERTY_ID` | The numeric ID of your GA4 property (NOT the `G-XXXXXX` measurement ID). Find it at GA4 → ⚙️ Admin → Property settings → Property ID. |
| `GA_SERVICE_ACCOUNT_JSON` | The whole service-account JSON, pasted verbatim. |

Without either, the tile shows the "Not connected" placeholder and
nothing breaks.

---

## 1. Find the GA4 property ID

1. Open https://analytics.google.com
2. Make sure you're in the right account + property (the one with
   measurement ID `G-S891R3L8LZ` — the Kaiveron one).
3. Click ⚙️ **Admin** in the bottom-left.
4. Under **Property**, click **Property details**.
5. The **Property ID** at the top is a number like `499123456`. Copy it.

## 2. Enable the Analytics Data API in Google Cloud

The service account lives in a Google Cloud project. If you don't have
one for Kaiveron yet, this step creates one.

1. Open https://console.cloud.google.com
2. Top bar → project dropdown → **New Project**:
   - Name: `kaiveron` (or whatever)
   - Click **Create**
3. Once the project is selected, go to
   https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
4. Click **Enable**. (Wait ~30s for it to activate.)

## 3. Create the service account

1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
2. **+ Create service account**
   - Service account name: `kaiveron-ga4-reader`
   - ID: (auto-fills)
   - Description: `Reads GA4 realtime data for the admin dashboard`
   - Click **Create and continue**
3. Skip the "Grant this service account access to project" step — GA
   permissions are configured on the GA side, not in GCP IAM.
4. Click **Done**.
5. Click into the new service account row, go to the **Keys** tab,
   **Add key** → **Create new key** → **JSON** → **Create**.
6. A JSON file downloads. Keep it safe — **this is a credential**, treat
   it like a password. Don't commit it to git.

## 4. Grant the service account Viewer on the GA4 property

This is the step that's easy to miss.

1. Back in GA4 (https://analytics.google.com → ⚙️ Admin)
2. Under **Property**, click **Property access management**
3. Click the **+** in the top-right → **Add users**
4. Paste the service account's email — it looks like
   `kaiveron-ga4-reader@<project-id>.iam.gserviceaccount.com`
   (find it on the GCP service accounts page if you forgot)
5. Standard roles: **Viewer** is enough
6. **Add**

## 5. Set the env vars on App Runner

```bash
SVC=arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab

aws apprunner describe-service --service-arn "$SVC" --region us-east-1 --output json > /tmp/svc.json

# Read the downloaded JSON into a variable. (Replace the path.)
SA_JSON=$(cat ~/Downloads/kaiveron-xxxxxxx.json)

# Patch + push the source-config
jq --arg pid "499123456" --arg sa "$SA_JSON" '
  .Service.SourceConfiguration
  | .CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentVariables.GA_PROPERTY_ID = $pid
  | .CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentVariables.GA_SERVICE_ACCOUNT_JSON = $sa
' /tmp/svc.json > /tmp/svc-new.json

aws apprunner update-service --service-arn "$SVC" \
  --source-configuration "$(cat /tmp/svc-new.json)" \
  --region us-east-1
```

App Runner restarts (~3 min). When it's back the admin dashboard's GA4
tile flips from the placeholder to live numbers.

> **Base64 alternative.** If the raw JSON breaks the env var parser
> (rare; App Runner accepts multiline strings, but YMMV), set the value
> as base64 instead: `cat key.json | base64 | pbcopy`. The backend's
> `getClient()` detects base64 by checking whether the value starts
> with `{`.

## 6. Verify

```bash
curl -s https://api.kaiveron.com/api/v1/admin/ga/realtime \
  -H "Authorization: Bearer <admin access token>" | jq
```

Expected when working:

```json
{
  "configured": true,
  "available":  true,
  "activeUsers": 1,
  "views30m": 14,
  "topPages":  [ { "path": "/community", "users": 1 }, ... ],
  "topCountries": [ { "country": "India", "users": 1 } ],
  "generatedAt": 1780397...
}
```

Expected when env vars aren't set: `{"configured": false}` (tile shows
the placeholder).

Expected when env vars are set but the API call fails (most often
because step 4 was missed): `{"configured": true, "available": false}`
(tile shows the red error state). Check App Runner logs — the backend
logs the exact GA4 error message.

## Security notes

- The service account can ONLY read GA4 data for properties it has been
  granted access to. It has no access to anything else in your Google
  Cloud project.
- The JSON includes a private key — never commit it. If it leaks,
  delete the key from the service account's **Keys** tab and create a
  new one.
- Rotate the key yearly. Delete + recreate; update App Runner env.
