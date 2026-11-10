
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose");
require("dotenv").config();

// ========================================
// EXPRESS CONFIGURATION
// ========================================

const app = express();

const PORT = process.env.PORT || 5000;

const CLIENT_URL = (
  process.env.CLIENT_URL || "http://localhost:3000"
).replace(/\/+$/, "");

const allowedOrigins = [
  CLIENT_URL,
  "http://localhost:3000",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS_ORIGIN_DENIED"));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ========================================
// MONGODB CONFIGURATION
// ========================================

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error(
    "MONGODB_URI environment variable is missing"
  );
}

const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000,
});

const DATABASE_NAME = "careconnectDB";

let databasePromise = null;

async function connectDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      await mongoClient.connect();

      const database = mongoClient.db(DATABASE_NAME);

      await database
        .collection("participants")
        .createIndex(
          { eventId: 1, userId: 1 },
          { unique: true }
        );

      await database.command({ ping: 1 });

      console.log("MongoDB Connected Successfully!");

      return database;
    })().catch((error) => {
      databasePromise = null;

      console.error("MongoDB connection error:", error);

      throw error;
    });
  }

  return databasePromise;
}

async function getCollections() {
  const database = await connectDatabase();

  return {
    database,
    eventsCollection: database.collection("events"),
    participantsCollection:
      database.collection("participants"),
  };
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function isValidEventId(id) {
  return /^[a-fA-F0-9]{24}$/.test(id);
}

function escapeRegex(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function isValidFutureDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.toISOString().slice(0, 10) === value &&
    value > getToday()
  );
}

function toOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

// ========================================
// BETTER AUTH JWT CONFIGURATION
// ========================================

// Better Auth publishes public signing keys here.
// The backend fetches keys when a JWT is verified.

const JWKS_URL = `${CLIENT_URL}/api/auth/jwks`;

const jwks = createRemoteJWKSet(
  new URL(JWKS_URL)
);

const expectedIssuer = toOrigin(
  process.env.JWT_ISSUER || CLIENT_URL
);

// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================

async function verifyUser(req, res, next) {
  try {
    const authorization =
      req.headers.authorization || "";

    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        message: "Please login first",
      });
    }

    let payload;

    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: expectedIssuer,
        audience: expectedIssuer,
      });

      payload = verified.payload;
    } catch (error) {
      console.warn(
        "JWT verification failed:",
        error.message
      );

      return res.status(401).json({
        message: "Unauthorized. Please login again.",
      });
    }

    if (!payload?.sub || !payload?.email) {
      return res.status(401).json({
        message: "Invalid authentication token",
      });
    }

    req.authUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || "",
      image: payload.image || null,
    };

    return next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(503).json({
      message: "Authentication service unavailable",
    });
  }
}

// ========================================
// HEALTH CHECK
// PUBLIC API
// ========================================

app.get("/", (req, res) => {
  return res.status(200).json({
    message: "CareConnect Server is Running!",
  });
});

// ========================================
// GET ALL UPCOMING EVENTS
// PUBLIC API
// ========================================

app.get("/events", async (req, res) => {
  try {
    const { eventsCollection } =
      await getCollections();

    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim().slice(0, 100)
        : "";

    const eventType =
      typeof req.query.type === "string"
        ? req.query.type.trim()
        : "";

    const filters = [
      {
        eventDate: {
          $gt: getToday(),
        },
      },
    ];

    if (search) {
      const searchRegex = new RegExp(
        escapeRegex(search),
        "i"
      );

      filters.push({
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { location: searchRegex },
        ],
      });
    }

    if (eventType) {
      filters.push({
        eventType: new RegExp(
          `^${escapeRegex(eventType)}$`,
          "i"
        ),
      });
    }

    const events = await eventsCollection
      .find({ $and: filters })
      .sort({ eventDate: 1 })
      .toArray();

    return res.status(200).json(events);
  } catch (error) {
    console.error(
      "Failed to fetch events:",
      error
    );

    return res.status(500).json({
      message: "Failed to load events",
    });
  }
});

// ========================================
// GET RECENT UPCOMING EVENTS
// PUBLIC API
// ========================================

app.get("/events/recent", async (req, res) => {
  try {
    const { eventsCollection } =
      await getCollections();

    const events = await eventsCollection
      .find({
        eventDate: {
          $gt: getToday(),
        },
      })
      .sort({ eventDate: 1 })
      .limit(6)
      .toArray();

    return res.status(200).json(events);
  } catch (error) {
    console.error(
      "Failed to fetch recent events:",
      error
    );

    return res.status(500).json({
      message: "Failed to load recent events",
    });
  }
});

// ========================================
// GET SINGLE EVENT DETAILS
// PUBLIC API
// ========================================

app.get("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidEventId(id)) {
      return res.status(400).json({
        message: "Invalid Event ID",
      });
    }

    const { eventsCollection } =
      await getCollections();

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
    console.error(
      "Failed to fetch event details:",
      error
    );

    return res.status(500).json({
      message: "Failed to load event details",
    });
  }
});

// ========================================
// CREATE NEW EVENT
// PRIVATE API
// ========================================

app.post(
  "/events",
  verifyUser,
  async (req, res) => {
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

      const missingFields = requiredFields.filter(
        (field) =>
          typeof event?.[field] !== "string" ||
          !event[field].trim()
      );

      if (missingFields.length > 0) {
        return res.status(400).json({
          message:
            "Missing or invalid required fields",
          fields: missingFields,
        });
      }

      const eventDate = event.eventDate.trim();

      if (!isValidFutureDate(eventDate)) {
        return res.status(400).json({
          message:
            "Event date must be in the future",
        });
      }

      const { eventsCollection } =
        await getCollections();

      const newEvent = {
        title: event.title.trim(),
        description: event.description.trim(),
        eventType: event.eventType.trim(),
        thumbnail: event.thumbnail.trim(),
        location: event.location.trim(),
        eventDate,

        creatorEmail: req.authUser.email,
        organizerName: req.authUser.name || "",
        creatorId: req.authUser.id,

        createdAt: new Date(),
      };

      const result =
        await eventsCollection.insertOne(newEvent);

      return res.status(201).json({
        message: "Event created successfully",
        insertedId: result.insertedId,
      });
    } catch (error) {
      console.error(
        "Failed to create event:",
        error
      );

      return res.status(500).json({
        message: "Failed to create event",
      });
    }
  }
);

// ========================================
// JOIN EVENT
// PRIVATE API
// ========================================

app.post(
  "/events/:id/join",
  verifyUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidEventId(id)) {
        return res.status(400).json({
          message: "Invalid Event ID",
        });
      }

      const {
        eventsCollection,
        participantsCollection,
      } = await getCollections();

      const eventId = new ObjectId(id);

      const event = await eventsCollection.findOne({
        _id: eventId,
      });

      if (!event) {
        return res.status(404).json({
          message: "Event not found",
        });
      }

      if (event.eventDate <= getToday()) {
        return res.status(400).json({
          message:
            "This event is no longer open for joining",
        });
      }

      const existingParticipant =
        await participantsCollection.findOne({
          eventId,
          userId: req.authUser.id,
        });

      if (existingParticipant) {
        return res.status(409).json({
          message:
            "You have already joined this event",
        });
      }

      const participant = {
        eventId,
        userId: req.authUser.id,
        userEmail: req.authUser.email,
        joinedAt: new Date(),
      };

      const result =
        await participantsCollection.insertOne(
          participant
        );

      return res.status(201).json({
        message: "Event joined successfully",
        insertedId: result.insertedId,
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          message:
            "You have already joined this event",
        });
      }

      console.error(
        "Failed to join event:",
        error
      );

      return res.status(500).json({
        message: "Failed to join event",
      });
    }
  }
);

// ========================================
// LEAVE EVENT
// PRIVATE API
// ========================================

app.delete(
  "/events/:id/join",
  verifyUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidEventId(id)) {
        return res.status(400).json({
          message: "Invalid Event ID",
        });
      }

      const { participantsCollection } =
        await getCollections();

      const result =
        await participantsCollection.deleteOne({
          eventId: new ObjectId(id),
          userId: req.authUser.id,
        });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          message:
            "You have not joined this event",
        });
      }

      return res.status(200).json({
        message: "You have left the event",
      });
    } catch (error) {
      console.error(
        "Failed to leave event:",
        error
      );

      return res.status(500).json({
        message: "Failed to leave event",
      });
    }
  }
);

// ========================================
// CHECK JOIN STATUS
// PRIVATE API
// ========================================

app.get(
  "/events/:id/join-status",
  verifyUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidEventId(id)) {
        return res.status(400).json({
          message: "Invalid Event ID",
        });
      }

      const { participantsCollection } =
        await getCollections();

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

// ========================================
// GET MY JOINED EVENTS
// PRIVATE API
// ========================================

app.get(
  "/my-joined-events",
  verifyUser,
  async (req, res) => {
    try {
      const { participantsCollection } =
        await getCollections();

      const participations =
        await participantsCollection
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

      return res
        .status(200)
        .json(participations);
    } catch (error) {
      console.error(
        "Failed to fetch joined events:",
        error
      );

      return res.status(500).json({
        message: "Failed to load joined events",
      });
    }
  }
);

// ========================================
// GET MY CREATED EVENTS
// PRIVATE API
// ========================================

app.get(
  "/my-events",
  verifyUser,
  async (req, res) => {
    try {
      const { eventsCollection } =
        await getCollections();

      const events = await eventsCollection
        .find({
          $or: [
            {
              creatorId: req.authUser.id,
            },
            {
              creatorEmail: req.authUser.email,
            },
          ],
        })
        .sort({ createdAt: -1 })
        .toArray();

      return res.status(200).json(events);
    } catch (error) {
      console.error(
        "Failed to load my events:",
        error
      );

      return res.status(500).json({
        message: "Failed to load your events",
      });
    }
  }
);

// ========================================
// UPDATE MY EVENT
// PRIVATE API
// ========================================

app.patch(
  "/events/:id",
  verifyUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidEventId(id)) {
        return res.status(400).json({
          message: "Invalid Event ID",
        });
      }

      const { eventsCollection } =
        await getCollections();

      const eventId = new ObjectId(id);

      const existingEvent =
        await eventsCollection.findOne({
          _id: eventId,
        });

      if (!existingEvent) {
        return res.status(404).json({
          message: "Event not found",
        });
      }

      const isOwner = existingEvent.creatorId
        ? existingEvent.creatorId ===
          req.authUser.id
        : existingEvent.creatorEmail ===
          req.authUser.email;

      if (!isOwner) {
        return res.status(403).json({
          message:
            "You can only update your own events",
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
        if (
          Object.hasOwn(
            req.body || {},
            field
          )
        ) {
          if (
            typeof req.body[field] !== "string" ||
            !req.body[field].trim()
          ) {
            return res.status(400).json({
              message: `Invalid ${field}`,
            });
          }

          updates[field] =
            req.body[field].trim();
        }
      }

      if (
        Object.keys(updates).length === 0
      ) {
        return res.status(400).json({
          message:
            "No valid fields provided",
        });
      }

      if (
        updates.eventDate &&
        !isValidFutureDate(
          updates.eventDate
        )
      ) {
        return res.status(400).json({
          message:
            "Event date must be in the future",
        });
      }

      updates.updatedAt = new Date();

      const ownershipFilter =
        existingEvent.creatorId
          ? {
              creatorId: req.authUser.id,
            }
          : {
              creatorEmail:
                req.authUser.email,
            };

      const result =
        await eventsCollection.updateOne(
          {
            _id: eventId,
            ...ownershipFilter,
          },
          {
            $set: updates,
          }
        );

      if (result.matchedCount === 0) {
        return res.status(403).json({
          message:
            "Event ownership could not be verified",
        });
      }

      return res.status(200).json({
        message:
          "Event updated successfully",
      });
    } catch (error) {
      console.error(
        "Update event error:",
        error
      );

      return res.status(500).json({
        message:
          "Failed to update event",
      });
    }
  }
);

// ========================================
// DELETE MY EVENT
// PRIVATE API
// ========================================

app.delete(
  "/events/:id",
  verifyUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidEventId(id)) {
        return res.status(400).json({
          message: "Invalid Event ID",
        });
      }

      const {
        eventsCollection,
        participantsCollection,
      } = await getCollections();

      const eventId = new ObjectId(id);

      const existingEvent =
        await eventsCollection.findOne({
          _id: eventId,
        });

      if (!existingEvent) {
        return res.status(404).json({
          message: "Event not found",
        });
      }

      const isOwner = existingEvent.creatorId
        ? existingEvent.creatorId ===
          req.authUser.id
        : existingEvent.creatorEmail ===
          req.authUser.email;

      if (!isOwner) {
        return res.status(403).json({
          message:
            "You can only delete your own events",
        });
      }

      const ownershipFilter =
        existingEvent.creatorId
          ? {
              creatorId: req.authUser.id,
            }
          : {
              creatorEmail:
                req.authUser.email,
            };

      const result =
        await eventsCollection.deleteOne({
          _id: eventId,
          ...ownershipFilter,
        });

      if (
        result.deletedCount === 0
      ) {
        return res.status(403).json({
          message:
            "Event could not be deleted",
        });
      }

      await participantsCollection.deleteMany({
        eventId,
      });

      return res.status(200).json({
        message:
          "Event deleted successfully",
      });
    } catch (error) {
      console.error(
        "Delete event error:",
        error
      );

      return res.status(500).json({
        message:
          "Failed to delete event",
      });
    }
  }
);

// ========================================
// HOMEPAGE STATISTICS
// PUBLIC API
// ========================================

app.get("/stats", async (req, res) => {
  try {
    const {
      database,
      eventsCollection,
      participantsCollection,
    } = await getCollections();

    const today = getToday();

    const [
      upcomingEvents,
      totalEvents,
      participations,
      members,
    ] = await Promise.all([
      eventsCollection.countDocuments({
        eventDate: {
          $gt: today,
        },
      }),

      eventsCollection.countDocuments(),

      participantsCollection.countDocuments(),

      database
        .collection("user")
        .countDocuments(),
    ]);

    return res.status(200).json({
      upcomingEvents,
      totalEvents,
      participations,
      members,
    });
  } catch (error) {
    console.error(
      "Failed to fetch statistics:",
      error
    );

    return res.status(500).json({
      message: "Failed to load statistics",
    });
  }
});

// ========================================
// ERROR HANDLING
// ========================================

app.use((error, req, res, next) => {
  console.error(
    "Express error:",
    error
  );

  if (
    error.message ===
    "CORS_ORIGIN_DENIED"
  ) {
    return res.status(403).json({
      message: "Origin not allowed",
    });
  }

  if (
    error.type === "entity.too.large"
  ) {
    return res.status(413).json({
      message: "Request body too large",
    });
  }

  return res.status(500).json({
    message: "Internal Server Error",
  });
});

// ========================================
// START SERVER
// ========================================

// Start local Express server.
// Vercel imports the exported app.

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `CareConnect Server running on port ${PORT}`
    );
  });
}

module.exports = app;
