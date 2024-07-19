const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Product = require("./productSchema");
const Coupon = require("./couponSchema");

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
    },
    items: [
      {
        product_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        variant: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "product.variants",
          required: true,
        },
        color: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Color",
        },
        size: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Size",
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: [1, `Quantity Can't be less than 1`],
        },
        price: {
          type: Number,
        },
        itemTotal: {
          type: Number,
        },
      },
    ],
    totalPrice: {
      type: Number,
    },
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
    },
    couponDiscount: {
      type: Number,
      default: 0,
    },
    payable: {
      type: Number,
    },
  },
  { timestamps: true }
);

cartSchema.statics.clearCart = async function (userId) {
  return await this.findOneAndUpdate(
    { userId: userId },
    {
      $set: {
        items: [],
        totalPrice: 0,
        coupon: null,
        couponDiscount: 0,
        payable: 0,
      },
    },
    { new: true }
  );
};

module.exports = mongoose.model("Cart", cartSchema);
