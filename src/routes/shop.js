const express = require("express");
const router = express.Router();

const Cart = require("../model/cartSchema");

const shopController = require("../controller/shopController");
const cartController = require("../controller/cartController");

const { isLoggedIn } = require("../middlewares/authMiddleware");

const { cartList } = require("../middlewares/cartMiddleware");
const userController = require("../controller/userController");
const bestSelling = require("../helpers/bestSelling");

router.use(async (req, res, next) => {
  if (req.isAuthenticated()) {
    res.locals.user = req.user;
  }
  // res.locals.success = req.flash("success");
  // res.locals.error = req.flash("error");
  next();
});

router.get("/", shopController.getHome);
router.get("/shop", shopController.search);

router.get("/shop/product/:id", shopController.getProduct);

// router.get("/search", shopController.search);
router.get("/contact", shopController.getContact);

router.get("/shop/order-success", isLoggedIn, cartController.getOrderSuccess);

router.get("/bestSelling", bestSelling.getBestSellingProducts);

module.exports = router;
