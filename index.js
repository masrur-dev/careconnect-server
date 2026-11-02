
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// =====================================
// EXPRESS CONFIGURATION
// =====================================

const app = express();
const port = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());

// =====================================
// MONGODB CONFIGURATION
// =====================================

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(uri);

// =====================================
// HELPER FUNCTIONS
// =====================================

const getToday = () => {
  return new Date().toISOString().slice(0, 10);
};

const isValidEventId = (id) => {
  return /^[a-fA-F0-9]{24}$/.test(id);
};

// =====================================
// BETTER AUTH SESSION VERIFICATION
// =====================================

const verifyUser = async (req, res, next) => {
  try {
    const cookie = req.headers.cookie;

    if (!cookie) {
      return res.status(401).json({
        message: "Please login first",
      });
    }

    const response = await fetch(
      `${CLIENT_URL}/api/auth/get-session`,
      {
        method: "GET",
        headers: {
          cookie,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return res.status(503).json({
        message: "Unable to verify login session",
      });
    }

    const session = await response.json();

    if (!session?.user?.id || !session?.user?.email) {
      return res.status(401).json({
        message: "Unauthorized. Please login again.",
      });
    }

    req.authUser = session.user;

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(503).json({
      message: "Authentication service unavailable",
    });
  }
};

// =====================================
// DATABASE CONNECTION AND API ROUTES
// =====================================

async function run() {
  try {
    await client.connect();

    const database = client.db("careconnectDB");

    // MongoDB Collections
    const eventsCollection = database.collection("events");

    const participantsCollection =
      database.collection("participants");

    // Prevent the same user joining the same event twice
    await participantsCollection.createIndex(
      { eventId: 1, userId: 1 },
      { unique: true }
    );

    await database.command({ ping: 1 });

    console.log("MongoDB Connected Successfully!");

    // =====================================
    // GET - SERVER HEALTH
    // =====================================

    app.get("/", (req, res) => {
      res.status(200).json({
        message: "CareConnect Server is Running!",
      });
    });

    // =====================================
    // GET - ALL UPCOMING EVENTS
    // =====================================

    app.get("/events", async (req, res) => {
      try {
        const events = await eventsCollection
          .find({
            eventDate: { $gt: getToday() },
          })
          .sort({ eventDate: 1 })
          .toArray();

        return res.status(200).json(events);
      } catch (error) {
        console.error("Failed to fetch events:", error);

        return res.status(500).json({
          message: "Failed to load events",
        });
      }
    });

    // =====================================
    // GET - RECENT 6 UPCOMING EVENTS
    // =====================================

    app.get("/events/recent", async (req, res) => {
      try {
        const events = await eventsCollection
          .find({
            eventDate: { $gt: getToday() },
          })
          .sort({ eventDate: 1 })
          .limit(6)
          .toArray();

        return res.status(200).json(events);
      } catch (error) {
        console.error("Failed to fetch recent events:", error);

        return res.status(500).json({
          message: "Failed to load recent events",
        });
      }
    });

    // =====================================
    // GET - SINGLE EVENT DETAILS
    // =====================================

    app.get("/events/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidEventId(id)) {
          return res.status(400).json({
            message: "Invalid Event ID",
          });
        }

        const event = await eventsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!event) {
          return res.status(404).json({
            message: "Event not found",
          });
        }

        return res.status(200).json(event);
      } catch (error) {
        console.error("Failed to fetch event details:", error);

        return res.status(500).json({
          message: "Failed to load event details",
        });
      }
    });

    // =====================================
    // POST - CREATE NEW EVENT
    // PRIVATE API
    // =====================================

    app.post("/events", verifyUser, async (req, res) => {
      try {
        const event = req.body;

        const requiredFields = [
          "title",
          "description",
          "eventType",
          "thumbnail",
          "location",
          "eventDate",
        ];

        // Validate required fields
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

        // Validate future event date
        const eventDate = event.eventDate.trim();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
          return res.status(400).json({
            message: "Invalid event date format",
          });
        }

        const date = new Date(`${eventDate}T00:00:00Z`);

        if (
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !== eventDate ||
          eventDate <= getToday()
        ) {
          return res.status(400).json({
            message: "Event date must be in the future",
          });
        }

        // Create event document
        const newEvent = {
          title: event.title.trim(),
          description: event.description.trim(),
          eventType: event.eventType.trim(),
          thumbnail: event.thumbnail.trim(),
          location: event.location.trim(),
          eventDate,

          // Always use verified user information
          creatorEmail: req.authUser.email,
          organizerName: req.authUser.name || "",
          creatorId: req.authUser.id,

          createdAt: new Date(),
        };

        const result = await eventsCollection.insertOne(newEvent);

        return res.status(201).json({
          message: "Event created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Failed to create event:", error);

        return res.status(500).json({
          message: "Failed to create event",
        });
      }
    });

    // =====================================
    // POST - JOIN EVENT
    // PRIVATE API
    // =====================================

    app.post("/events/:id/join", verifyUser, async (req, res) => {
      try {
        const { id } = req.params;

        // Validate event ID
        if (!isValidEventId(id)) {
          return res.status(400).json({
            message: "Invalid Event ID",
          });
        }

        const eventId = new ObjectId(id);

        // Check if event exists
        const event = await eventsCollection.findOne({
          _id: eventId,
        });

        if (!event) {
          return res.status(404).json({
            message: "Event not found",
          });
        }

        // Only future events can be joined
        if (event.eventDate <= getToday()) {
          return res.status(400).json({
            message: "This event is no longer open for joining",
          });
        }

        // Check if already joined
        const existingParticipant =
          await participantsCollection.findOne({
            eventId,
            userId: req.authUser.id,
          });

        if (existingParticipant) {
          return res.status(409).json({
            message: "You have already joined this event",
          });
        }

        // Save participation
        const participant = {
          eventId,
          userId: req.authUser.id,
          userEmail: req.authUser.email,
          joinedAt: new Date(),
        };

        const result = await participantsCollection.insertOne(
          participant
        );

        return res.status(201).json({
          message: "Event joined successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        // MongoDB unique index prevents duplicate joins
        if (error.code === 11000) {
          return res.status(409).json({
            message: "You have already joined this event",
          });
        }

        console.error("Failed to join event:", error);

        return res.status(500).json({
          message: "Failed to join event",
        });
      }
    });


// ++++++++++

    // =====================================
    // GET - CHECK JOIN STATUS
    // PRIVATE API
    // =====================================

    app.get(
      "/events/:id/join-status",
      verifyUser,
      async (req, res) => {
        try {
          const { id } = req.params;

          // Validate Event ID
          if (!isValidEventId(id)) {
            return res.status(400).json({
              message: "Invalid Event ID",
            });
          }

          // Check MongoDB participants collection
          const participant =
            await participantsCollection.findOne({
              eventId: new ObjectId(id),
              userId: req.authUser.id,
            });

          return res.status(200).json({
            joined: Boolean(participant),
          });
        } catch (error) {
          console.error(
            "Failed to check join status:",
            error
          );

          return res.status(500).json({
            message: "Failed to check join status",
          });
        }
      }
    );
// ++++++++++++

// 
// =====================================
// GET - MY JOINED EVENTS
// PRIVATE API
// =====================================

app.get("/my-joined-events", verifyUser, async (req, res) => {
  try {
    const participations = await participantsCollection
      .aggregate([
        {
          $match: {
            userId: req.authUser.id,
          },
        },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "event",
          },
        },
        {
          $unwind: "$event",
        },
        {
          $replaceRoot: {
            newRoot: "$event",
          },
        },
        {
          $sort: {
            eventDate: 1,
          },
        },
      ])
      .toArray();

    return res.status(200).json(participations);
  } catch (error) {
    console.error("Failed to fetch joined events:", error);

    return res.status(500).json({
      message: "Failed to load joined events",
    });
  }
});
// ++++


//
// =====================================
// GET - MY CREATED EVENTS
// PRIVATE API
// =====================================

app.get("/my-events", verifyUser, async (req, res) => {
  try {
    const events = await eventsCollection
      .find({
        creatorEmail: req.authUser.email,
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(events);
  } catch (error) {
    console.error("Failed to load my events:", error);

    return res.status(500).json({
      message: "Failed to load your events",
    });
  }
});
//======

//

    // =====================================
    // PATCH - UPDATE MY EVENT
    // PRIVATE API
    // =====================================

    app.patch("/events/:id", verifyUser, async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidEventId(id)) {
          return res.status(400).json({
            message: "Invalid Event ID",
          });
        }

        const eventId = new ObjectId(id);

        // Find existing event
        const existingEvent = await eventsCollection.findOne({
          _id: eventId,
        });

        if (!existingEvent) {
          return res.status(404).json({
            message: "Event not found",
          });
        }

        // Verify event ownership
        const isOwner = existingEvent.creatorId
          ? existingEvent.creatorId === req.authUser.id
          : existingEvent.creatorEmail === req.authUser.email;

        if (!isOwner) {
          return res.status(403).json({
            message: "You can only update your own events",
          });
        }

        const allowedFields = [
          "title",
          "description",
          "eventType",
          "thumbnail",
          "location",
          "eventDate",
        ];

        const updates = {};

        for (const field of allowedFields) {
          if (Object.hasOwn(req.body || {}, field)) {
            if (
              typeof req.body[field] !== "string" ||
              !req.body[field].trim()
            ) {
              return res.status(400).json({
                message: `Invalid ${field}`,
              });
            }

            updates[field] = req.body[field].trim();
          }
        }

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({
            message: "No valid fields provided",
          });
        }

        // Validate event date if updated
        if (updates.eventDate) {
          const date = new Date(
            `${updates.eventDate}T00:00:00Z`
          );

          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(updates.eventDate) ||
            Number.isNaN(date.getTime()) ||
            date.toISOString().slice(0, 10) !== updates.eventDate ||
            updates.eventDate <= getToday()
          ) {
            return res.status(400).json({
              message: "Event date must be in the future",
            });
          }
        }

        updates.updatedAt = new Date();

        const result = await eventsCollection.updateOne(
          {
            _id: eventId,
            ...(existingEvent.creatorId
              ? { creatorId: req.authUser.id }
              : { creatorEmail: req.authUser.email }),
          },
          {
            $set: updates,
          }
        );

        if (result.matchedCount === 0) {
          return res.status(403).json({
            message: "Event ownership could not be verified",
          });
        }

        return res.status(200).json({
          message: "Event updated successfully",
        });
      } catch (error) {
        console.error("Update event error:", error);

        return res.status(500).json({
          message: "Failed to update event",
        });
      }
    });

    // =====================================
    // DELETE - MY EVENT
    // PRIVATE API
    // =====================================

    app.delete("/events/:id", verifyUser, async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidEventId(id)) {
          return res.status(400).json({
            message: "Invalid Event ID",
          });
        }

        const eventId = new ObjectId(id);

        const existingEvent = await eventsCollection.findOne({
          _id: eventId,
        });

        if (!existingEvent) {
          return res.status(404).json({
            message: "Event not found",
          });
        }

        const isOwner = existingEvent.creatorId
          ? existingEvent.creatorId === req.authUser.id
          : existingEvent.creatorEmail === req.authUser.email;

        if (!isOwner) {
          return res.status(403).json({
            message: "You can only delete your own events",
          });
        }

        const result = await eventsCollection.deleteOne({
          _id: eventId,
          ...(existingEvent.creatorId
            ? { creatorId: req.authUser.id }
            : { creatorEmail: req.authUser.email }),
        });

        if (result.deletedCount === 0) {
          return res.status(403).json({
            message: "Event could not be deleted",
          });
        }

        // Remove participants of deleted event
        await participantsCollection.deleteMany({
          eventId,
        });

        return res.status(200).json({
          message: "Event deleted successfully",
        });
      } catch (error) {
        console.error("Delete event error:", error);

        return res.status(500).json({
          message: "Failed to delete event",
        });
      }
    });
//

    // =====================================
    // START EXPRESS SERVER
    // =====================================

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
