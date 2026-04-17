const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MONDAY_API_KEY   = process.env.MONDAY_API_KEY;   // your Monday API token
const SUBITEM_NAME     = "Approve Script";             // exact subitem name to watch
const TARGET_STATUS    = "Production";                 // label to set on the parent item
const STATUS_COLUMN_ID = "status";                     // column ID of the Status column on the parent board
// ───────────────────────────────────────────────────────────────────────────

// Monday.com sends a challenge on webhook creation — we must echo it back
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Respond to Monday's verification challenge
  if (body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event) return res.sendStatus(200);

  const { pulseId, value } = event; // pulseId = the subitem's item ID

  // Only care about status-change events where the new value is "Done"
  const newLabel = value?.label?.text;
  if (!newLabel || newLabel.toLowerCase() !== "done") {
    return res.sendStatus(200);
  }

  try {
    // 1️⃣ Fetch the subitem's name and its parent item ID
    const subitemData = await mondayQuery(`
      query {
        items(ids: [${pulseId}]) {
          name
          parent_item { id }
        }
      }
    `);

    const subitem = subitemData?.data?.items?.[0];
    if (!subitem) return res.sendStatus(200);

    const subitemName = subitem.name?.trim();
    const parentId    = subitem.parent_item?.id;

    // 2️⃣ Check if this is the subitem we care about
    if (subitemName !== SUBITEM_NAME) {
      console.log(`Skipping subitem "${subitemName}" — not "${SUBITEM_NAME}"`);
      return res.sendStatus(200);
    }

    if (!parentId) {
      console.error("No parent item found for subitem", pulseId);
      return res.sendStatus(200);
    }

    // 3️⃣ Get the parent item's board ID
    const parentData = await mondayQuery(`
      query {
        items(ids: [${parentId}]) {
          board { id }
        }
      }
    `);

    const boardId = parentData?.data?.items?.[0]?.board?.id;
    if (!boardId) {
      console.error("Could not find board for parent item", parentId);
      return res.sendStatus(200);
    }

    // 4️⃣ Get the status column's index value for "Production"
    const boardData = await mondayQuery(`
      query {
        boards(ids: [${boardId}]) {
          columns(ids: ["${STATUS_COLUMN_ID}"]) {
            settings_str
          }
        }
      }
    `);

    const settingsStr = boardData?.data?.boards?.[0]?.columns?.[0]?.settings_str;
    const settings    = JSON.parse(settingsStr || "{}");
    const labels      = settings.labels || {};

    // Find the index whose label matches TARGET_STATUS
    const statusIndex = Object.entries(labels).find(
      ([, label]) => label.toLowerCase() === TARGET_STATUS.toLowerCase()
    )?.[0];

    if (statusIndex === undefined) {
      console.error(`Status label "${TARGET_STATUS}" not found on board ${boardId}`);
      console.error("Available labels:", labels);
      return res.sendStatus(200);
    }

    // 5️⃣ Update the parent item's status to "Production"
    await mondayQuery(`
      mutation {
        change_column_value(
          board_id: ${boardId},
          item_id: ${parentId},
          column_id: "${STATUS_COLUMN_ID}",
          value: "{\\"index\\": ${statusIndex}}"
        ) {
          id
        }
      }
    `);

    console.log(`✅ Set parent item ${parentId} status to "${TARGET_STATUS}"`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("Error handling webhook:", err);
    return res.sendStatus(500);
  }
});

// Helper: call Monday's GraphQL API
async function mondayQuery(query) {
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": MONDAY_API_KEY,
    },
    body: JSON.stringify({ query }),
  });
  return response.json();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
