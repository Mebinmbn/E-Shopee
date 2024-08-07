const mongoose = require("mongoose");

const User = require("../model/userSchema");
const Returns = require("../model/returnSchema");
const Order = require("../model/orderSchema");
const Color = require("../model/attributes/colorSchema");
const Size = require("../model/attributes/sizeSchema");
const Product = require("../model/productSchema");

const layout = "./layouts/adminLayout";

module.exports = {
  getReturnRequests: async (req, res) => {
    let perPage = 13;
    let page = req.query.page || 1;

    let returns = await Returns.find({})
      .populate("order_id user_id product_id")
      .sort({ createdAt: -1 })
      .skip(perPage * page - perPage)
      .limit(perPage);
    // find the variant from the product_id using variant
    // console.log(returns[0]);

    for (let request of returns) {
      const product = request.product_id;
      const variant = product.variants.find(
        (variant) => variant._id.toString() === request.variant.toString()
      );
      request.variantDetails = variant;
      // // find the color and size details from the variant
      const color = await Color.findById(variant.color);
      const size = await Size.findById(variant.size);

      // console.log(color, size);

      request.productDetail = { color: color.name, size: size.value };

      if (request.status !== "pending") {
        request.return = true;
      } else {
        request.return = false;
      }
    }

    const count = await Returns.countDocuments();
    const nextPage = parseInt(page) + 1;
    const hasNextPage = nextPage <= Math.ceil(count / perPage);

    // console.log("product id: ", returns[0].order_id._id);

    res.render("admin/returns", {
      returns,
      current: page,
      pages: Math.ceil(count / perPage),
      nextPage: hasNextPage ? nextPage : null,
      layout,
    });
  },

  approveReturn: async (req, res) => {
    const { id, order_id, variant, item_id, product_id } = req.body;

    console.log("rreq body === ", req.body);
    try {
      const product = await Product.findById(product_id);
      product.variants.forEach((variant) =>
        console.log(variant._id.toString())
      );
      console.log(variant);

      const order = await Order.findOne({
        _id: order_id,
        "items.orderID": item_id,
        "items.variant": variant,
      });

      let quantity;

      if (order) {
        // Assuming 'items' is an array and each item has a 'quantity' property
        quantity = order.items.find(
          (item) => item.orderID === item_id
        )?.quantity;
      }

      if (product) {
        const variantIdToFind = variant; // Assuming 'variant' is a valid string

        let variantIndex = -1;

        for (let i = 0; i < product.variants.length; i++) {
          if (product.variants[i]._id.toString() === variantIdToFind) {
            variantIndex = i;
            break; // Exit the loop early
          }
        }
        console.log(variantIndex);
        if (variantIndex === -1) {
          return res.status(404).json({ error: "Variant not found" });
        }

        console.log(product.variants[variantIndex]);

        product.variants[variantIndex].stock += quantity;

        // product.stock += item.quantity; // Increment the quantity of the product
        await product.save(); // Save the updated product
        console.log("product updated");
      } else {
        console.log("product not found");
      }

      const returnRequest = await Returns.findByIdAndUpdate(
        new mongoose.Types.ObjectId(id),
        { status: "approved" },
        { new: true }
      );

      if (!returnRequest) {
        return res
          .status(404)
          .json({ success: false, message: "Return request not found" });
      }
      let update = { "items.$.status": "In-Return" };

      await Order.updateOne(
        {
          _id: order_id,
          "items.orderID": item_id,
          "items.variant": variant,
        },
        { $set: update }
      );

      // Update the current product variant stock

      return res.status(200).json({
        success: true,
        message: "Return request approved",
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to approve return request" });
    }
  },

  declineReturn: async (req, res) => {
    const { id } = req.params;

    try {
      const returnRequest = await Returns.findByIdAndUpdate(id, {
        status: "rejected",
      });

      if (!returnRequest) {
        return res
          .status(404)
          .json({ success: false, message: "Return request not found" });
      }

      return res.status(200).json({
        success: true,
        message: "Return request declined",
      });
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to decline return request" });
    }
  },
};
