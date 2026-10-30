const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("CareConnect Server is Running!");
});


<CodeBlock language="javascript" editable>
const events = [
  {
    id: 1,
    title: "Winter Clothes Distribution",
    location: "Mirpur 10, Dhaka",
    eventType: "Donation",
    eventDate: "2026-12-15"
  },
  {
    id: 2,
    title: "Tree Plantation Campaign",
    location: "Uttara, Dhaka",
    eventType: "Plantation",
    eventDate: "2026-12-20"
  },
  {
    id: 3,
    title: "Community Cleanup",
    location: "Dhanmondi, Dhaka",
    eventType: "Cleanup",
    eventDate: "2026-12-25"
  }
];


app.get("/events", (req, res) => {
res.json(events);
});
</CodeBlock>

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
