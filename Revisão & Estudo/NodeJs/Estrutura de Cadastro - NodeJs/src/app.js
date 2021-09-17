const express = require("express");
const cors = require("cors");
const routes = require("./routes");

class App {
  constructor() {
    this.app = express();
    this.middlewares();
    this.routes();
  }
  middlewares() {
    this.app.use(express.json());

    this.app.use((req, res, next) => {
      res.header("Access-Controll-Allow-Origin", "*"); //aceitar qualquer origem
      res.header("Access-Controll-Allow-Methods", "GET, POST, PUT, DELETE");
      res.header(
        "Access-Controll-Allow-Headers",
        "Access, Content-type, Authorization, Acept, Origin, X-Requested-With"
      );
      this.app.use(cors());
      next();
    });
  }
  routes() {
    this.app.use(routes);
  }
}
module.exports = new App().app;
