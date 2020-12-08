require("dotenv").config();
const app = require("express")();
const mongodb = require("mongodb");
const { Expo } = require("expo-server-sdk");
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});
const { ObjectId } = require("mongodb");
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "*",
  },
});

const main = async () => {
  const url = process.env.DATABASE_URL || "mongodb://localhost:27017/deal";

  const connect = await mongodb.connect(url, { useNewUrlParser: true });
  const db = connect.db("deal");
  const Chats = db.collection("chats");
  const Users = db.collection("users");

  const users = {};
  let roomId = null;
  const limit = 50;

  app.get("/chatRoom/:userId", async (req, res) => {
    const { userId } = req.params;

    let chatRooms = [];

    const chats = await Chats.find({
      participant: {
        $in: [new ObjectId(userId)],
      },
    })
      .sort({ updatedAt: -1 })
      .toArray();

    if (chats.length) {
      for (let chat of chats) {
        let user;
        if (String(userId) === String(chat.participant[0])) {
          user = await Users.findOne({
            _id: new ObjectId(chat.participant[1]),
          });
        } else {
          user = await Users.findOne({
            _id: new ObjectId(chat.participant[0]),
          });
        }

        chatRooms.push({
          roomId: chat._id,
          userId: user._id,
          name: user.name,
          avatar: user.avartar,
          deviceToken: user.deviceToken,
          lastMessage: chat.messages[chat.messages.length - 1],
          active: false,
        });
      }
    }

    res.status(200).json({
      success: true,
      data: chatRooms,
    });
  });

  app.get("/chat/:roomId/:page", async (req, res) => {
    const page = req.params.page;
    const skip = (+page - 1) * limit;
    const chats = await Chats.aggregate([
      {
        $match: { _id: new ObjectId(req.params.roomId) },
      },
      {
        $project: {
          _id: 0,
          messages: 1,
        },
      },
      {
        $unwind: {
          path: "$messages",
        },
      },
      {
        $sort: {
          "messages.timestamp": -1,
        },
      },
      {
        $skip: skip,
      },
      {
        $limit: limit,
      },
      {
        $group: {
          _id: null,
          messages: {
            $push: "$messages",
          },
        },
      },
    ]).toArray();

    res.status(200).json({
      success: true,
      data: chats.length ? chats : [],
    });
  });

  io.on("connection", async (socket) => {
    socket.on("initial", async (data) => {
      if (data) {
        const chats = await Chats.find({
          participant: {
            $in: [new ObjectId(data.userId)],
          },
        })
          .sort({ updatedAt: -1 })
          .toArray();

        if (chats.length) {
          const rooms = chats.map((room) => String(room._id));
          users[data.userId] = rooms;
          socket.join(rooms);

          const chatRooms = {};

          for (let chat of chats) {
            let user;
            if (String(data.userId) === String(chat.participant[0])) {
              user = await Users.findOne({
                _id: new ObjectId(chat.participant[1]),
              });
            } else {
              user = await Users.findOne({
                _id: new ObjectId(chat.participant[0]),
              });
            }

            chatRooms[chat._id] = {
              roomId: chat._id,
              userId: user._id,
              name: user.name,
              avatar: user.avartar,
              message: chat.messages,
              deviceToken: user.deviceToken,
              active: false,
            };
          }

          socket.emit("restore chat", chatRooms);
        }
      }
    });

    socket.on("restore chat room", async (data) => {
      const chats = await Chats.aggregate([
        {
          $match: { _id: new ObjectId(data.roomId) },
        },
        {
          $project: {
            _id: 0,
            messages: 1,
          },
        },
        {
          $unwind: {
            path: "$messages",
          },
        },
        {
          $sort: {
            "messages.timestamp": -1,
          },
        },
        {
          $limit: limit,
        },
        {
          $group: {
            _id: null,
            messages: {
              $push: "$messages",
            },
          },
        },
      ]).toArray();
      socket.emit("restore chat room", chats);
    });

    socket.on("chat", async (data) => {
      if ("query" in data) {
        let room = await Chats.findOne({
          participant: {
            $all: [
              new ObjectId(data.query.userId),
              new ObjectId(data.query.productUserId),
            ],
          },
        });

        if (room) {
          roomId = room._id;
        } else {
          room = await Chats.insertOne({
            messages: [],
            participant: [
              new ObjectId(data.query.userId),
              new ObjectId(data.query.productUserId),
            ],
            updatedAt: null,
          });

          roomId = room.insertedId;
        }

        socket.join(String(roomId));

        let user = await Users.findOne(
          {
            _id: new ObjectId(data.query.productUserId),
          },
          {
            projection: {
              _id: 1,
              name: 1,
              avartar: 1,
              deviceToken: 1,
            },
          }
        );

        if (!user) {
          user = null;
        }

        socket.emit("join", {
          roomId: roomId,
          userId: user._id,
          name: user.name,
          avatar: user.avartar,
          deviceToken: user.deviceToken,
        });
      }
    });

    socket.on("chat message", async (data) => {
      if (data.to) {
        if (Expo.isExpoPushToken(data.deviceToken)) {
          const messages = [];
          messages.push({
            to: data.deviceToken,
            sound: "default",
            body: data.message,
            data: { roomId: data.to, name: data.user.name },
          });

          let chunks = expo.chunkPushNotifications(messages);
          for (let chunk of chunks) {
            expo.sendPushNotificationsAsync(chunk);
          }
        }

        let user = data.user;
        await Chats.updateOne(
          { _id: new ObjectId(data.to) },
          {
            $set: {
              updatedAt: new Date(),
            },
            $push: {
              messages: {
                message: data.message,
                userId: new ObjectId(user.id),
                timestamp: new Date(),
              },
            },
          }
        );
        io.to(String(data.to)).emit("chat message", {
          data,
          dataUser: { userId: user.id, name: user.name, avatar: user.avartar },
        });
      }
    });

    socket.on("disconnect", () => {
      console.log("disconnect");
    });
  });

  http.listen(6002, () => {
    console.log(`SOCKET IS RUNNING ON 6002`);
  });
};

main();
