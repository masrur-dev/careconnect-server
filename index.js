
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// Express Application
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();

    const database = client.db("careconnectDB");
    const eventsCollection = database.collection("events");

    await database.command({ ping: 1 });

    console.log("MongoDB Connected Successfully!");

    // Home API
    app.get("/", (req, res) => {
      res.send("CareConnect Server is Running!");
    });

    // GET - All Upcoming Events
    app.get("/events", async (req, res) => {
      try {
        const today = new Date()
          .toISOString()
          .slice(0, 10);

        const events = await eventsCollection
          .find({
            eventDate: { $gt: today },
          })
          .sort({ eventDate: 1 })
          .toArray();

        res.json(events);
      } catch (error) {
        console.error("Failed to fetch events:", error);

        res.status(500).json({
          message: "Failed to load events",
        });
      }
    });

    // GET - Recent 6 Upcoming Events
    app.get("/events/recent", async (req, res) => {
      try {
        const today = new Date()
          .toISOString()
          .slice(0, 10);

        const recentEvents = await eventsCollection
          .find({
            eventDate: { $gt: today },
          })
          .sort({ eventDate: 1 })
          .limit(6)
          .toArray();

        res.json(recentEvents);
      } catch (error) {
        console.error("Failed to fetch recent events:", error);

        res.status(500).json({
          message: "Failed to load recent events",
        });
      }
    });

    // POST - Create New Event
    // Temporary test route; JWT protection comes later.
    app.post("/events", async (req, res) => {
      try {
        const event = req.body;

        const requiredFields = [
          "title",
          "description",
          "eventType",
          "thumbnail",
          "location",
          "eventDate",
          "creatorEmail",
        ];

        const missingFields = requiredFields.filter(
          (field) =>
            typeof event?.[field] !== "string" ||
            !event[field].trim()
        );

        if (missingFields.length > 0) {
          return res.status(400).json({
            message: "Missing or invalid required fields",
            fields: missingFields,
          });
        }

        const date = new Date(
          `${event.eventDate}T00:00:00Z`
        );

        const today = new Date()
          .toISOString()
          .slice(0, 10);

        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(event.eventDate) ||
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !==
            event.eventDate ||
          event.eventDate <= today
        ) {
          return res.status(400).json({
            message: "Event date must be in the future",
          });
        }

        const newEvent = {
          title: event.title.trim(),
          description: event.description.trim(),
          eventType: event.eventType.trim(),
          thumbnail: event.thumbnail.trim(),
          location: event.location.trim(),
          eventDate: event.eventDate,
          creatorEmail: event.creatorEmail.trim(),
          createdAt: new Date(),
        };

        const result = await eventsCollection.insertOne(
          newEvent
        );

        res.status(201).json({
          message: "Event created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Failed to create event:", error);

        res.status(500).json({
          message: "Failed to create event",
        });
      }
    });

    // Start Server
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exitCode = 1;
    await client.close();
  }
}

run();
