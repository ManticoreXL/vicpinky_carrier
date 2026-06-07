#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/string.hpp>
#include "turtlebot3_hardware/led_driver.hpp"

class HeadlightNode : public rclcpp::Node {
public:
    HeadlightNode() : Node("headlight_node"), is_blinking_(false), toggle_count_(0) {
        try {
            driver_ = std::make_shared<LedDriver>(18, 16);
            driver_->set_color(255, 255, 255); // 백색
        } catch (const std::exception& e) {
            RCLCPP_ERROR(this->get_logger(), "Hardware Error: %s", e.what());
            throw;
        }

        saved_state_ = driver_->get_state();

        sub_ = this->create_subscription<std_msgs::msg::String>(
            "/turtlebot/headlight_cmd", 10,
            std::bind(&HeadlightNode::cmd_callback, this, std::placeholders::_1));

        // 0.3초 주기의 타이머
        timer_ = this->create_wall_timer(
            std::chrono::milliseconds(300),
            std::bind(&HeadlightNode::timer_callback, this));
            
        RCLCPP_INFO(this->get_logger(), "Headlight NeoPixel Node Started.");
    }

private:
    void cmd_callback(const std_msgs::msg::String::SharedPtr msg) {
        std::string cmd = msg->data;
        
        if (cmd == "on") {
            is_blinking_ = false;
            saved_state_ = true;
            driver_->set_state(true);
        } 
        else if (cmd == "off") {
            is_blinking_ = false;
            saved_state_ = false;
            driver_->set_state(false);
        } 
        else if (cmd == "blink") {
            if (!is_blinking_) {
                saved_state_ = driver_->get_state();
                toggle_count_ = 0;
                is_blinking_ = true;
            }
        }
    }

    void timer_callback() {
        if (is_blinking_) {
            if (toggle_count_ < 3) {
                // 3회 상태 반전
                bool next_state = !(driver_->get_state());
                driver_->set_state(next_state);
                toggle_count_++;
            } else {
                // 반전 후 보존해둔 초기 상태로 복귀
                driver_->set_state(saved_state_);
                is_blinking_ = false;
            }
        }
    }

    std::shared_ptr<LedDriver> driver_;
    rclcpp::Subscription<std_msgs::msg::String>::SharedPtr sub_;
    rclcpp::TimerBase::SharedPtr timer_;
    
    bool is_blinking_;
    int toggle_count_;
    bool saved_state_;
};

int main(int argc, char **argv) {
    rclcpp::init(argc, argv);
    try {
        rclcpp::spin(std::make_shared<HeadlightNode>());
    } catch (...) {
        RCLCPP_ERROR(rclcpp::get_logger("rclcpp"), "Node terminated abruptly.");
    }
    rclcpp::shutdown();
    return 0;
}