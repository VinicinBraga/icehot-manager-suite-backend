const express = require("express");
const server = express();
const port = 3000;
server.use(express.json());

const skills = ["Html", "Css", "Js", "NodeJs", "Python"];

server.get("/skills/:index", (req, res) => {
  const { index } = req.params;
  console.log(skills[index]);
});

server.listen(port, () => console.log(`Example app listening on port port!`));
